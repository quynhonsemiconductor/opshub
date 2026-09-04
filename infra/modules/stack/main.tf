// The opshub product stack — one module, both environments.
//
// develop and production used to be two 370-line files that were 95% identical, so
// every change had to be made twice and the differences that mattered were invisible
// among the ones that did not. Everything structural now lives here; the callers in
// ../../live/<env> hold only the values that genuinely differ.
//
// This module deliberately does NOT own the VPC, the NAT gateway, the ALB or the WAF.
// Those are shared per-environment and live once in qnsc-infra/live/runtime-<env>;
// this stack consumes them via remote state. Per-product resources — RDS, cache,
// Fargate services, queues, the upload bucket — are here.

data "aws_caller_identity" "current" {}

# ── Read shared layer outputs (ECR URLs, KMS ARN, Cloudflare zone) ────────────
# _shared owns the ECR repos and the OIDC roles, and re-exports platform-level
# outputs from qnsc-infra. Dependency: the product's _shared stack must be applied
# before this one (infra-apply.yml orders them).
data "terraform_remote_state" "shared" {
  backend = "s3"
  config = {
    bucket = "qnsc-tofu-state"
    key    = var.shared_state_key
    region = "ap-southeast-1"
  }
}

# ── Shared runtime layer (VPC + NAT + ALB, and the WAF in prod) ───────────────
data "terraform_remote_state" "runtime" {
  backend = "s3"
  config = {
    bucket = "qnsc-tofu-state"
    key    = var.runtime_state_key
    region = "ap-southeast-1"
  }
}

locals {
  # Values that are DERIVED, not chosen. Anything an environment picks is a variable;
  # anything computed from those lives here, so the two callers cannot drift in how a
  # value is assembled — only in what they feed in.
  name     = "${var.product}-${var.env_slug}"
  app_url  = "https://${var.app_domain}"
  ecr_base = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.region}.amazonaws.com"

  api_log_group    = "/ecs/${local.name}-api"
  worker_log_group = "/ecs/${local.name}-worker"

  kms_key_arn        = data.terraform_remote_state.shared.outputs.kms_key_arn
  cloudflare_zone_id = try(data.terraform_remote_state.shared.outputs.cloudflare_zone_id, "")

  # ── Connection-pool budget ──────────────────────────────────────────────────
  # `DATABASE_POOL_MAX` defaults to 20 per PROCESS in env.schema.ts, and nothing here
  # set it. That default is a per-task number multiplied by the autoscaler's ceiling,
  # so production can legitimately open 6 api tasks x 20 + 4 worker tasks x 20 = 200
  # connections against a db.t4g.micro that accepts ~112. It has not bitten yet only
  # because neither environment carries real load.
  #
  # The failure mode is indirect, which is what makes it worth asserting rather than
  # documenting: the pool queues, `connectionTimeoutMillis` (5s, drizzle.provider.ts)
  # elapses, and every affected request pays five seconds before erroring — while
  # CPU-target autoscaling responds by adding MORE tasks, each bringing another pool,
  # starving the database further.
  #
  # Postgres computes max_connections as LEAST(DBInstanceClassMemory/9531392, 5000).
  # Listed per class rather than computed, so an unlisted class fails the plan instead
  # of silently inheriting a number that does not hold for it.
  db_max_connections_by_class = {
    "db.t4g.micro"  = 112
    "db.t4g.small"  = 225
    "db.t4g.medium" = 450
    "db.t4g.large"  = 901
  }
  db_max_connections = local.db_max_connections_by_class[var.rds.instance_class]

  # Reserved off the top: 3 for Postgres' superuser slots, 10 for migrations (which
  # run DURING a deploy while api and worker are still up), 5 for an operator holding
  # a psql session while debugging.
  db_pool_budget = local.db_max_connections - 18

  # Split 60/40 api:worker, each divided by that service's autoscaling ceiling. The
  # worker's share is not proportional to its task count: a relay tick holds one
  # connection for its claim transaction while the row's work runs on a second, so it
  # needs at least two per task.
  api_pool_max    = max(4, floor(local.db_pool_budget * 0.6 / var.api.max_count))
  worker_pool_max = max(4, floor(local.db_pool_budget * 0.4 / var.worker.max_count))

  # `rediss://`, never `redis://`: the cache module enables transit encryption
  # unconditionally, so a plaintext scheme would simply fail to connect. ioredis turns
  # TLS on from the scheme alone, so the app needs no configuration. Not a secret — an
  # endpoint address grants nothing on its own — so it travels as plain env.
  # `.invalid` is reserved by RFC 2606 and can never resolve, so an idled environment
  # that somehow runs a task fails with a loud DNS error naming the cause rather than
  # quietly degrading. The real guard is the `check` block at the bottom of this file:
  # with the cache off, no task may run at all.
  valkey_url = var.cache.enabled ? "rediss://${module.cache[0].endpoint}:${module.cache[0].port}" : "rediss://cache-disabled.invalid:6379"

  tags = { Environment = var.env }

  # Injected into api AND worker. One list, because a secret the api can read and the
  # worker cannot is a runtime failure discovered in production, and the two lists
  # drifted apart exactly that way while they were maintained per environment.
  # ── Database credential, per service ────────────────────────────────────────
  # Read LIVE from the secret AWS owns and rotates; `:key::` selects one field of that
  # secret's JSON.
  #
  # This replaced a hand-populated `db-url` secret. RDS is created with
  # `manage_master_user_password = true`, so that copy went stale on every rotation and the
  # next deploy would die with 28P01 (password authentication failed for "app_admin") with
  # nothing drifting in Terraform to explain it. Host/port/name are not secret and travel as
  # plain env below; the app composes the URL (db/database-url.ts). Splitting the credential
  # into parts is also what makes least-privilege roles possible — while the whole thing
  # arrived as one URL there was nothing to point at another role.
  #
  # Now per-service rather than shared, because api and worker authenticate as DIFFERENT
  # roles once `db_least_privilege` is on. Under the flag the username stops being a secret
  # field — `opshub_app` is not a credential — so it moves to plain env alongside
  # host/port/name, and only the password comes from Secrets Manager.
  api_db_secrets = var.db_least_privilege ? [
    { name = "DATABASE_PASSWORD", secret_arn = module.secrets.secret_arns["db-app-password"] },
    ] : [
    { name = "DATABASE_USER", secret_arn = "${module.rds.master_secret_arn}:username::" },
    { name = "DATABASE_PASSWORD", secret_arn = "${module.rds.master_secret_arn}:password::" },
  ]

  worker_db_secrets = var.db_least_privilege ? [
    { name = "DATABASE_PASSWORD", secret_arn = module.secrets.secret_arns["db-worker-password"] },
    ] : [
    { name = "DATABASE_USER", secret_arn = "${module.rds.master_secret_arn}:username::" },
    { name = "DATABASE_PASSWORD", secret_arn = "${module.rds.master_secret_arn}:password::" },
  ]

  api_db_env    = var.db_least_privilege ? [{ name = "DATABASE_USER", value = "opshub_app" }] : []
  worker_db_env = var.db_least_privilege ? [{ name = "DATABASE_USER", value = "opshub_worker" }] : []

  # Secrets both services share. The DATABASE_* pair is NOT here — see the two locals above.
  app_secrets = concat([
    # The public half is DERIVED from this at boot, so there is no second secret to fall
    # out of step with it. A mismatched pair is the one failure a keypair cannot
    # otherwise have: signing succeeds, every verification rejects, and both values look
    # individually valid to Terraform and to the app's env schema.
    { name = "JWT_PRIVATE_KEY", secret_arn = module.secrets.secret_arns["jwt-private"] },
    { name = "COOKIE_SECRET", secret_arn = module.secrets.secret_arns["cookie-secret"] },
    # Required by the env schema, so it is injected unconditionally rather than gated
    # like the two below: it is a random key this side generates, not a credential
    # minted in someone else's console, so there is no window where it cannot be set.
    { name = "CSRF_SECRET", secret_arn = module.secrets.secret_arns["csrf-secret"] },
    ],
    # The BFF's confidential-client secret. Gated for the same reason as Graph's: an
    # empty Secrets Manager value cannot be injected at all, so wiring it before the
    # Entra app registration has one would stop every task from starting. While it is
    # off, the login START still works and the callback's token exchange is what fails —
    # the app boots, and the Bearer path is unaffected.
    var.entra_client_secret_set ? [
      { name = "ENTRA_CLIENT_SECRET", secret_arn = module.secrets.secret_arns["entra-client-secret"] },
    ] : [],
    # Injected only once populated — see the variable. ECS cannot inject a secret that
    # holds no value: the task fails to start with
    # "ResourceInitializationError ... can't find the specified secret value for staging
    # label: AWSCURRENT". So wiring an OPTIONAL integration unconditionally makes it
    # mandatory in the worst way, and that is precisely what kept develop from ever
    # booting.
    var.graph_client_secret_set ? [
      { name = "GRAPH_CLIENT_SECRET", secret_arn = module.secrets.secret_arns["graph-client-secret"] },
  ] : [])

  # Env both services need. Same reasoning as app_secrets: the queue URL, the bucket
  # and the cache endpoint are the contract between them, so they cannot be allowed to
  # disagree about any of the three.
  shared_env = [
    # "production" in DEVELOP too, on purpose: NODE_ENV selects the app's SECURITY
    # posture (cookie flags, dev-login refusal, error verbosity), and a deployed
    # environment should never run the relaxed one. Environment identity travels in
    # tags and log groups instead.
    { name = "NODE_ENV", value = "production" },
    { name = "VALKEY_URL", value = local.valkey_url },
    { name = "AWS_REGION", value = var.region },
    # Head sampling, read by `resolveSampler` in libs/platform/src/observability/otel.ts and
    # asserted by otel.spec.ts. Shared rather than per-service so a trace that crosses from
    # api to worker is judged by one probability — differing values would drop the far half of
    # a trace and look like broken instrumentation.
    { name = "OTEL_SAMPLING_PROBABILITY", value = tostring(var.observability.sampling_probability) },
    # Non-secret connection parts; DATABASE_USER/PASSWORD arrive via secrets above.
    { name = "DATABASE_HOST", value = module.rds.address },
    { name = "DATABASE_PORT", value = tostring(module.rds.port) },
    { name = "DATABASE_NAME", value = module.rds.db_name },
    { name = "S3_FILES_BUCKET", value = module.app_bucket.bucket },
    { name = "ENTRA_TENANT_ID", value = var.entra_tenant_id },
    { name = "ENTRA_CLIENT_ID", value = var.entra_client_id },
    # The SPA origin, NOT the API origin: Entra redirects the browser here, and the
    # session cookie is set on that response — it has to land same-origin with the SPA or
    # the `__Host-` cookie is refused. The Pages Function forwards /v1/* to the API.
    # This exact string must also be registered as a redirect URI on the app registration.
    { name = "ENTRA_REDIRECT_URI", value = "${local.app_url}/v1/bff/callback" },
    # Terraform already knows the deployed tag, so the version needs no CI plumbing.
    # Read by the OTel resource and by the served OpenAPI document, both of which
    # reported "dev" in every environment before this was injected.
    { name = "SERVICE_VERSION", value = var.image_tag },
    # Mail. Both services send: the api sends inline where a caller waits for the result, the worker
    # relays the outbox — so a value set on one and not the other is a half outage that reads as a
    # flake. Shared for that reason rather than duplicated per service.
    { name = "EMAIL_PROVIDER", value = var.email_provider },
    { name = "MAIL_FROM_NAME", value = var.mail_from_name },
    { name = "MAIL_FROM_EMAIL", value = var.mail_from_email },
    { name = "MAIL_REPLY_TO", value = var.mail_reply_to },
    { name = "SES_CONFIGURATION_SET", value = aws_sesv2_configuration_set.email_feedback.configuration_set_name },
  ]
}

# ── Secrets (scaffolding only — values are set out of band) ───────────────────
# Terraform creates the CONTAINERS and never their contents: a value in state is a
# value in the state file. Each is created empty, which is also the "unpopulated"
# signal — a task injected with an empty secret fails to boot, so a forgotten secret
# is a failed deploy rather than an app running on a blank credential.
module "secrets" {
  source      = "git::https://github.com/quynhonsemiconductor/qnsc-tf-modules.git//modules/secrets?ref=secrets-v2.1.1"
  prefix      = "${var.product}/${var.env}"
  kms_key_arn = local.kms_key_arn

  recovery_window_days = var.secrets_recovery_window_days

  # Cost: collapse the set into one JSON secret. Staged across several applies — see
  # `secrets_bundle_name` in variables.tf for the ordering and why it is staged.
  bundle_name       = var.secrets_bundle_name
  use_bundle        = var.secrets_use_bundle
  create_standalone = var.secrets_create_standalone

  # Three secrets, not five. `db-url` is gone — the credential is read live from the
  # RDS-managed secret AWS rotates (see local.app_secrets) — and so is `jwt-public-key`,
  # which the app derives from the private half at boot.
  # Merged rather than a flat map so `observability-token` can be omitted ENTIRELY while the
  # OTel path is dormant. It is the one secret that cannot exist empty: the collector sidecar
  # reads it as an Authorization header, and ECS refuses to inject a secret with no value —
  # so creating it unconditionally would either sit unused (fine) or, once the sidecar is
  # switched on before it is populated, take the task down. Gating on the same flag that
  # creates the sidecar keeps those two facts in one place.
  secret_names = merge(var.observability.otlp_endpoint == "" ? {} : {
    "observability-token" = "Authorization header for the OTLP backend (e.g. 'Basic <base64>')"
    }, {
    "jwt-private"   = "JWT ES256 private key, EC P-256 (PEM or base64-encoded PEM). The public half is derived from it."
    "cookie-secret" = "Fastify cookie signing secret (min 32 chars)"
    "csrf-secret"   = "HMAC key binding a CSRF token to its session (min 32 chars). Distinct from cookie-secret so the two rotate independently."
    # NOTE: no "tunnel-token" key here any more. It belonged to the OLD manual-tunnel
    # design (cloudflared tunnel create by hand, id pasted into a variable) — Terraform
    # now owns the tunnel's whole lifecycle (module.tunnel) and creates its OWN separate
    # aws_secretsmanager_secret.tunnel_token, populated automatically from the tunnel
    # resource's own token output. Nothing reads this bundle's key any more.
    "entra-client-secret" = "Entra confidential-client secret for the BFF server-side code exchange"
    "graph-client-secret" = "Microsoft Graph app client secret (client-credentials flow for Graph sync jobs)"
    # Passwords for the least-privilege roles migration 0012 creates. The CONTAINERS exist
    # unconditionally so `secret_arns["db-app-password"]` always resolves and the IAM list
    # keeps a plan-time-known length; what is gated is the INJECTION — see
    # `db_role_passwords_set` and `db_least_privilege`. Empty until step 2 of the runbook.
    "db-app-password"    = "Password for the opshub_app Postgres role (api). [A-Za-z0-9_-], 24+ chars."
    "db-worker-password" = "Password for the opshub_worker Postgres role (worker). [A-Za-z0-9_-], 24+ chars."
  })

  tags = local.tags
}

# ── RDS PostgreSQL ────────────────────────────────────────────────────────────
module "rds" {
  source = "git::https://github.com/quynhonsemiconductor/qnsc-tf-modules.git//modules/rds?ref=rds-v2.1.2"

  identifier        = local.name
  subnet_ids        = data.terraform_remote_state.runtime.outputs.data_subnet_ids
  security_group_id = data.terraform_remote_state.runtime.outputs.sg_rds_id
  kms_key_arn       = local.kms_key_arn

  instance_class           = var.rds.instance_class
  allocated_storage_gb     = var.rds.allocated_storage_gb
  max_allocated_storage_gb = var.rds.max_allocated_storage_gb
  multi_az                 = var.rds.multi_az
  deletion_protection      = var.rds.deletion_protection
  backup_retention_days    = var.rds.backup_retention_days
  monitoring_interval      = var.rds.monitoring_interval

  tags = local.tags
}

# ── Cache (Valkey) ────────────────────────────────────────────────────────────
# A shared node per environment, NOT a Valkey sidecar per Fargate task, and the
# difference is correctness rather than cost.
#
# Develop ran a sidecar at localhost:6379 in each of the api and worker tasks, which
# gives every task a PRIVATE cache. Three things in this app assume one:
#
#   - SSE notifications publish on `user:{id}` from whichever api task handled the
#     write, and the browser is subscribed through a different one, so the event was
#     delivered only when the two happened to be the same task;
#   - `relay:wake` is published by the api and subscribed by the WORKER, in a
#     different task entirely, so it never arrived and delivery silently fell back to
#     the 5s cron poll;
#   - the authorization cache is invalidated on role writes, and an invalidation that
#     reaches only the publishing task leaves every other task serving revoked
#     permissions until the 300s TTL expires.
#
# A cheaper node is the correct lever if this ever needs one; moving the cache back
# into the task is not. At-rest KMS and transit encryption are both on, which is why
# the URL above is `rediss://`.
module "cache" {
  count  = var.cache.enabled ? 1 : 0
  source = "git::https://github.com/quynhonsemiconductor/qnsc-tf-modules.git//modules/cache?ref=cache-v1.1.0"

  name              = "${local.name}-valkey"
  subnet_ids        = data.terraform_remote_state.runtime.outputs.data_subnet_ids
  security_group_id = data.terraform_remote_state.runtime.outputs.sg_cache_id
  kms_key_arn       = local.kms_key_arn

  mode      = var.cache.mode
  node_type = var.cache.node_type

  tags = local.tags
}

# ── S3 upload bucket ──────────────────────────────────────────────────────────
module "app_bucket" {
  source = "git::https://github.com/quynhonsemiconductor/qnsc-tf-modules.git//modules/app-bucket?ref=app-bucket-v1.0.1"

  name          = "${var.product}-${var.env}-uploads"
  kms_key_arn   = local.kms_key_arn
  versioning    = true
  force_destroy = var.uploads.force_destroy

  # Browsers PUT straight to a presigned URL, so the bucket — not the API — has to
  # allow the SPA's origin. The app's own origin is always allowed; anything else is
  # an explicit per-environment addition.
  #
  # ALLOWED HEADERS MUST COVER EVERY SIGNED HEADER. `StorageService.presignUpload` signs
  # `content-type`, `content-length` and `content-disposition`, and returns all of them in
  # `requiredHeaders` for the client to send — but `Content-Disposition` was missing here, so the
  # preflight refused it and every browser upload failed with an opaque `net::ERR_FAILED`. Measured
  # from a real browser against LocalStack, whose bootstrap carried the same gap. A header the
  # signature covers and CORS does not is an upload that cannot happen.
  cors_rules = [{
    allowed_headers = ["Content-Type", "Content-Length", "Content-MD5", "Content-Disposition"]
    allowed_methods = ["PUT"]
    allowed_origins = concat([local.app_url], var.uploads.extra_cors_origins)
    expose_headers  = ["ETag"]
    max_age_seconds = 3600
  }]

  # NO LIFECYCLE RULE, deliberately — the application owns this cleanup.
  #
  # There was an `expire-unconfirmed-uploads` rule here with `prefix = "tmp/"`, and it matched nothing:
  # `StorageService.presignUpload` builds keys as `<resource_type>/<uploader_id>/<id>`, so no object has
  # ever been written under `tmp/`. The rule's own comment described a layout that does not exist.
  #
  # It was also redundant. `StorageCleanupCron` sweeps hourly, and it is strictly better placed than a
  # prefix rule could be: it reads `storage.stored_files`, so it deletes exactly the objects whose row
  # is still `pending` after 24 hours, and it deletes the row with them. A lifecycle rule can only match
  # on key or tag and would have to guess.
  #
  # The sweep is also COMPLETE, which is what makes dropping the backstop safe: `presignUpload` inserts
  # the `stored_files` row BEFORE it signs the URL, so an object cannot exist without a row for the cron
  # to find. Adding a real backstop later means tagging objects at presign and untagging on confirm —
  # worth doing only if that ordering ever changes.

  tags = local.tags
}

# ── ECS cluster ───────────────────────────────────────────────────────────────
module "ecs_cluster" {
  source = "git::https://github.com/quynhonsemiconductor/qnsc-tf-modules.git//modules/ecs-cluster?ref=ecs-cluster-v2.0.0"
  name   = local.name
  tags   = local.tags

  # Always stated, never inherited: the module default is "enhanced", whose per-task
  # metrics are billed as custom CloudWatch metrics. See the variable.
  container_insights = var.container_insights
}

# ── ECS service — API ─────────────────────────────────────────────────────────
module "api" {
  source = "git::https://github.com/quynhonsemiconductor/qnsc-tf-modules.git//modules/ecs-service?ref=ecs-service-v2.3.2"

  use_firelens = module.firelens_agent_api.enabled
  # Moves with the caller's build_runner/image_platforms in ONE change — see the
  # variable's own description for why setting one without the other fails at task
  # start rather than at apply.
  cpu_architecture = var.cpu_architecture

  service_name = "api"
  cluster_name = module.ecs_cluster.cluster_name
  cluster_arn  = module.ecs_cluster.cluster_arn
  region       = var.region
  image_uri    = "${local.ecr_base}/${var.product}-api:${var.image_tag}"

  cpu            = var.api.cpu
  memory         = var.api.memory
  container_port = 3000

  vpc_id            = data.terraform_remote_state.runtime.outputs.vpc_id
  subnet_ids        = data.terraform_remote_state.runtime.outputs.private_subnet_ids
  security_group_id = data.terraform_remote_state.runtime.outputs.sg_app_id

  # One task at rest in both environments; autoscaling adds more on load. Production
  # buys redundancy through `max_count` and the ALB health check rather than by
  # standing a second task up permanently.
  desired_count = 1
  min_count     = 1
  max_count     = var.api.max_count
  use_spot      = var.api.use_spot
  # Off for an environment driven by a schedule rather than by load: autoscaling would
  # fight `idle_schedule`, restoring the task it just scaled to zero.
  enable_autoscaling = var.api.enable_autoscaling
  cpu_target_pct     = var.api.cpu_target_pct
  memory_target_pct  = var.api.memory_target_pct
  log_retention_days = var.log_retention_days

  # Host-based routing on the SHARED ALB, so opshub and rally coexist on one listener.
  # Priority 200 is opshub's slot in both environments (rally holds 100) — a constant,
  # not a variable, because two products colliding on a priority is a deploy failure
  # and the value has to be reasoned about across repos, not per environment.
  # Tunnel and ALB are mutually exclusive. A task served by a tunnel must not also be an
  # ALB target: the target group would health-check a port the connector already owns,
  # and traffic could arrive by two paths with different TLS termination.
  #
  # `try()` on the listener ARN because the output is NULL now that the shared ALBs are
  # gone — referencing it directly fails the plan even on the tunnelled path, where the
  # value is never used.
  attach_alb        = !var.tunnel_enabled
  alb_listener_arn  = try(data.terraform_remote_state.runtime.outputs.https_listener_arn, "")
  alb_priority      = 200
  alb_path_patterns = ["/*"]
  alb_host_headers  = [var.api_domain]
  health_check_path = "/v1/healthz"

  # Merged into the task definition; the connector reaches the app at 127.0.0.1:3000
  # through the shared task network namespace. Empty list while the tunnel is off.
  additional_containers = concat(
    module.otel_agent_api.container_definitions,
    module.tunnel_api.container_definitions,
    module.firelens_agent_api.container_definitions,
  )

  # Includes the AWS-managed RDS secret: the execution role needs GetSecretValue on it
  # to inject DATABASE_USER/PASSWORD. Omit it and the task cannot start at all ("unable
  # to pull secrets") — a boot failure, not a runtime error. The migrator reuses the
  # api's roles, so it is covered by the api's copy of this list too.
  #
  # aws_secretsmanager_secret.tunnel_token[*].arn (not [0].arn): matches rally's own
  # fix for a real prod outage — tunnel_token's ARN is unknown-until-apply on an
  # environment where the secret doesn't exist yet, so a `[0]` index or a `length()`
  # call on it makes this whole expression's count unknown. `[*].arn` takes its
  # length from `count`, which is known from config regardless of the ARN's value.
  # module.firelens_agent_api.secret_arns is the router's own observability-token
  # read grant — missing it left the execution role unable to pull that secret too.
  secret_arns = concat(
    values(module.secrets.secret_arns),
    [module.rds.master_secret_arn],
    aws_secretsmanager_secret.tunnel_token[*].arn,
    module.firelens_agent_api.secret_arns,
  )
  kms_key_arn = local.kms_key_arn
  secrets     = concat(local.app_secrets, local.api_db_secrets)

  environment_vars = concat(local.shared_env, local.api_db_env, [
    { name = "PORT", value = "3000" },
    # Per-task pool ceiling, derived from the RDS class — see local.api_pool_max.
    { name = "DATABASE_POOL_MAX", value = tostring(local.api_pool_max) },
    { name = "CORS_ORIGINS", value = local.app_url },
    { name = "APP_URL", value = local.app_url },
    # Telemetry. `enabled` and `endpoint` both come FROM the sidecar module, so the app can
    # never be told to export to a collector that was not created — the two cannot disagree.
    { name = "OTEL_SERVICE_NAME", value = "${var.product}-api" },
    { name = "OTEL_ENABLED", value = tostring(module.otel_agent_api.enabled) },
    { name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = module.otel_agent_api.endpoint },
  ])

  s3_bucket_arns = concat([module.app_bucket.arn], module.firelens_agent_api.task_s3_bucket_arns)

  tags = merge(local.tags, { Service = "api" })
}

# ── ECS service — worker ──────────────────────────────────────────────────────
module "worker" {
  source = "git::https://github.com/quynhonsemiconductor/qnsc-tf-modules.git//modules/ecs-service?ref=ecs-service-v2.3.2"

  use_firelens = module.firelens_agent_worker.enabled
  # Moves with the caller's build_runner/image_platforms in ONE change — see the
  # variable's own description for why setting one without the other fails at task
  # start rather than at apply.
  cpu_architecture = var.cpu_architecture

  service_name = "worker"
  cluster_name = module.ecs_cluster.cluster_name
  cluster_arn  = module.ecs_cluster.cluster_arn
  region       = var.region
  image_uri    = "${local.ecr_base}/${var.product}-worker:${var.image_tag}"

  cpu    = var.worker.cpu
  memory = var.worker.memory

  vpc_id            = data.terraform_remote_state.runtime.outputs.vpc_id
  subnet_ids        = data.terraform_remote_state.runtime.outputs.private_subnet_ids
  security_group_id = data.terraform_remote_state.runtime.outputs.sg_app_id

  desired_count      = var.worker.min_count
  min_count          = var.worker.min_count
  max_count          = var.worker.max_count
  use_spot           = var.worker.use_spot
  enable_autoscaling = var.worker.enable_autoscaling
  log_retention_days = var.log_retention_days

  # No listener rule: the worker serves no HTTP traffic.
  attach_alb = false

  # No tunnel sidecar here — the worker is a relay with no HTTP surface. The collector is
  # still wanted: the outbox and webhook relays are exactly the code whose latency and
  # failures are invisible from a request trace.
  additional_containers = concat(
    module.otel_agent_worker.container_definitions,
    module.firelens_agent_worker.container_definitions,
  )

  # Includes the AWS-managed RDS secret: the execution role needs GetSecretValue on it
  # to inject DATABASE_USER/PASSWORD. Omit it and the task cannot start at all ("unable
  # to pull secrets") — a boot failure, not a runtime error. The migrator reuses the
  # api's roles, so it is covered by the api's copy of this list too.
  #
  # module.firelens_agent_worker.secret_arns is the worker's own router's
  # observability-token read grant — no tunnel_token here, the worker has no tunnel
  # sidecar (it serves no HTTP surface).
  secret_arns = concat(
    values(module.secrets.secret_arns),
    [module.rds.master_secret_arn],
    module.firelens_agent_worker.secret_arns,
  )
  kms_key_arn = local.kms_key_arn
  secrets     = concat(local.app_secrets, local.worker_db_secrets)

  # Not plain `local.shared_env`: the pool ceiling is per-SERVICE, because it divides
  # the shared budget by this service's own autoscaling ceiling.
  environment_vars = concat(local.shared_env, local.worker_db_env, [
    { name = "DATABASE_POOL_MAX", value = tostring(local.worker_pool_max) },
    { name = "OTEL_SERVICE_NAME", value = "${var.product}-worker" },
    { name = "OTEL_ENABLED", value = tostring(module.otel_agent_worker.enabled) },
    { name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = module.otel_agent_worker.endpoint },
  ])

  s3_bucket_arns = concat([module.app_bucket.arn], module.firelens_agent_worker.task_s3_bucket_arns)

  tags = merge(local.tags, { Service = "worker" })
}

# ── Migrator (one-shot task, run by the deploy pipeline) ──────────────────────
# Reuses the api's execution and task roles rather than minting its own: it reads the
# same database secret from the same KMS key, so a second pair of roles would be two
# copies of one grant to keep in step.
module "migrator" {
  source = "git::https://github.com/quynhonsemiconductor/qnsc-tf-modules.git//modules/oneshot-task?ref=oneshot-task-v2.0.0"

  name               = "${local.name}-migrator"
  container_name     = "migrator"
  image              = "${local.ecr_base}/${var.product}-migrator:${var.image_tag}"
  cpu                = 512
  memory             = 1024
  execution_role_arn = module.api.execution_role_arn
  task_role_arn      = module.api.task_role_arn
  region             = var.region
  log_retention_days = var.log_retention_days

  # Same value as the api and worker, deliberately: the migrator runs the same image
  # family, so an architecture split here would fail only at `db:migrate` time — after
  # a clean apply and a green build — which is the worst place to discover it.
  cpu_architecture = var.cpu_architecture

  environment = {
    NODE_ENV   = "production"
    AWS_REGION = var.region
    # Non-secret connection parts; USER/PASSWORD arrive via secrets below.
    DATABASE_HOST = module.rds.address
    DATABASE_PORT = tostring(module.rds.port)
    DATABASE_NAME = module.rds.db_name
  }

  # The master credential, and it stays that way when the least-privilege roles land:
  # the migrator runs DDL, so it needs the owner. Narrowing it additionally requires
  # transferring schema ownership, which is a separate and more disruptive step.
  #
  # Read live from the AWS-managed secret so a rotation can never leave the migrator
  # holding a stale password — the failure that made this worth changing.
  #
  # The two role passwords ride along once `db_role_passwords_set` is on, because the
  # migrator task definition is what the one-off cutover task overrides: it is the only
  # workload holding the master credential AND sitting in the database's subnets, and
  # `ALTER ROLE ... LOGIN PASSWORD ...` needs both the admin connection and the new
  # passwords in the same process. RDS is not publicly accessible and ECS Exec is off, so
  # there is no other path in.
  #
  # Gated rather than unconditional: ECS cannot inject a Secrets Manager secret that holds
  # no value, and injecting these while empty would stop the migrator from starting — which
  # blocks every deploy, since the migrator runs before the services roll.
  secrets = merge({
    DATABASE_USER     = "${module.rds.master_secret_arn}:username::"
    DATABASE_PASSWORD = "${module.rds.master_secret_arn}:password::"
    }, var.db_role_passwords_set ? {
    DATABASE_APP_PASSWORD    = module.secrets.secret_arns["db-app-password"]
    DATABASE_WORKER_PASSWORD = module.secrets.secret_arns["db-worker-password"]
  } : {})

  tags = merge(local.tags, { Service = "migrator" })
}

# ── Cloudflare Tunnel connector (api ingress without a load balancer) ─────────
# A cloudflared sidecar dials OUT to the Cloudflare edge, so the api serves with no
# inbound listener, no target group and no public IPv4.
#
# This is not merely cheaper, it is now REQUIRED: the shared ALBs in
# qnsc-infra/live/runtime-{dev,prod} were deleted once both products moved to tunnels,
# so `runtime.outputs.https_listener_arn` is null and there is nothing left to attach
# to. An ALB was also a second TLS termination inside an already-Cloudflare-proxied
# path — the SPA is a Pages project whose Function proxies /v1/* here, and the old ALB
# security group admitted only Cloudflare edge ranges.
#
# Gated on `tunnel_enabled`: with it false the module produces no container, so this is
# inert until a tunnel and its token exist for the environment.
#
# The WORKER gets none — it is a relay with no HTTP surface.
#
# Created and owned by Terraform, unlike rally's two tunnels (created by hand, then
# adopted) — opshub has never had one, so there is nothing existing to preserve and no
# adopt-then-manage two-step needed. `hostname` is set from creation, so this tunnel
# is never inert (rally production once went live with an ingress-rule-less tunnel
# that connected, reported healthy, and 503'd every request).
module "tunnel" {
  count  = var.tunnel_enabled && var.cloudflare_account_id != "" ? 1 : 0
  source = "git::https://github.com/quynhonsemiconductor/qnsc-tf-modules.git//modules/cf-tunnel?ref=cf-tunnel-v0.2.1"

  account_id = var.cloudflare_account_id
  name       = local.name

  hostname = var.api_domain
  service  = "http://localhost:3000"
}

# The connector token, Terraform-managed — separate from the shared secrets bundle
# (an operator-populated JSON object) rather than a key inside it, so Terraform never
# clobbers the rest of that bundle by writing one field of it.
resource "aws_secretsmanager_secret" "tunnel_token" {
  count = var.tunnel_enabled && var.cloudflare_account_id != "" ? 1 : 0

  name                    = "${var.product}/${var.env}/tunnel-token-tf"
  description             = "Cloudflare Tunnel connector token (TUNNEL_TOKEN). Managed by Terraform — do not edit by hand."
  kms_key_id              = local.kms_key_arn
  recovery_window_in_days = var.secrets_recovery_window_days

  tags = local.tags
}

resource "aws_secretsmanager_secret_version" "tunnel_token" {
  count = var.tunnel_enabled && var.cloudflare_account_id != "" ? 1 : 0

  secret_id     = aws_secretsmanager_secret.tunnel_token[0].id
  secret_string = module.tunnel[0].token
}

module "tunnel_api" {
  source = "git::https://github.com/quynhonsemiconductor/qnsc-tf-modules.git//modules/tunnel-agent?ref=tunnel-agent-v1.0.0"

  tunnel_token_secret_arn = var.tunnel_enabled ? aws_secretsmanager_secret.tunnel_token[0].arn : ""
  app_port                = 3000
  log_group               = local.api_log_group
  region                  = var.region
}

# ── Telemetry collector sidecars ──────────────────────────────────────────────
# One per service: each needs its own log group, and a sidecar can only ever see the task it
# lives in.
#
# Both are a NO-OP until `observability.otlp_endpoint` is set AND the `observability-token`
# secret holds a value — the module returns empty container lists, and `OTEL_ENABLED` below is
# gated on the same flag, so the app is never told to export into a void. That is what makes
# turning telemetry on a one-line change per environment rather than a migration, and it is
# why adopting this costs nothing while it is off.
module "otel_agent_api" {
  source = "git::https://github.com/quynhonsemiconductor/qnsc-tf-modules.git//modules/observability-agent?ref=observability-agent-v1.0.1"

  product       = var.product
  env           = var.env
  otlp_endpoint = var.observability.otlp_endpoint
  # try(): the secret is not created while the OTel path is dormant, and the module is a no-op
  # in that state anyway — so an absent ARN is the correct input here, not an error.
  token_secret_arn = try(module.secrets.secret_arns["observability-token"], "")
  log_group        = local.api_log_group
  region           = var.region
}

module "otel_agent_worker" {
  source = "git::https://github.com/quynhonsemiconductor/qnsc-tf-modules.git//modules/observability-agent?ref=observability-agent-v1.0.1"

  product          = var.product
  env              = var.env
  otlp_endpoint    = var.observability.otlp_endpoint
  token_secret_arn = try(module.secrets.secret_arns["observability-token"], "")
  log_group        = local.worker_log_group
  region           = var.region
}

# Ships each service's router (task-level, non-app) logs to Loki, same shared stack the
# OTel sidecars push metrics/traces to. Adopted from rally — opshub previously had no log
# shipping at all, so an incident meant reading CloudWatch Logs Insights by hand instead
# of Grafana Explore alongside the metrics and traces for the same request.
module "firelens_agent_api" {
  source = "git::https://github.com/quynhonsemiconductor/qnsc-tf-modules.git//modules/firelens-agent?ref=firelens-agent-v0.2.2"

  service_name     = "${var.product}-api"
  product          = var.product
  env              = var.env
  otlp_endpoint    = var.observability.otlp_endpoint
  token_secret_arn = try(module.secrets.secret_arns["observability-token"], "")
  router_log_group = local.api_log_group
  region           = var.region
  kms_key_arn      = local.kms_key_arn
}

module "firelens_agent_worker" {
  source = "git::https://github.com/quynhonsemiconductor/qnsc-tf-modules.git//modules/firelens-agent?ref=firelens-agent-v0.2.2"

  service_name     = "${var.product}-worker"
  product          = var.product
  env              = var.env
  otlp_endpoint    = var.observability.otlp_endpoint
  token_secret_arn = try(module.secrets.secret_arns["observability-token"], "")
  router_log_group = local.worker_log_group
  region           = var.region
  kms_key_arn      = local.kms_key_arn
}

# ── Web SPA — Cloudflare Pages ────────────────────────────────────────────────
# The SPA is served from Cloudflare Pages (zero egress, native SPA routing) and the
# API from its own Cloudflare-proxied subdomain, so the ALB is never directly
# reachable. Gated on cloudflare_account_id so the stack applies before the
# Cloudflare account is wired.
module "web" {
  count  = var.cloudflare_account_id != "" ? 1 : 0
  source = "git::https://github.com/quynhonsemiconductor/qnsc-tf-modules.git//modules/pages-web?ref=pages-web-v1.0.1"

  account_id  = var.cloudflare_account_id
  name        = "${local.name}-web"
  zone_id     = local.cloudflare_zone_id
  domain      = local.cloudflare_zone_id != "" ? var.app_domain : ""
  record_name = local.cloudflare_zone_id != "" ? var.web_record : ""
  comment     = "${local.name} web SPA → Cloudflare Pages (managed by ${var.product}-infra ${var.env})"

  # Upstream for the Pages Function at apps/web/functions/v1/[[path]].ts, which
  # forwards /v1/* (including /v1/bff/*) to the API. That proxy is what keeps the SPA
  # and the API on ONE origin, and it is a requirement rather than an optimisation:
  # a `__Host-` session cookie cannot be set cross-site, so the BFF auth flow only
  # works same-origin. It also removes CORS from the browser path entirely.
  #
  # The SPA is built with VITE_API_URL unset, so it calls relative /v1 paths and has
  # no knowledge of this hostname; setting VITE_API_URL would send the browser
  # straight to the API origin and break the cookie.
  production_env_vars = {
    API_ORIGIN = "https://${var.api_domain}"
  }
}

# ── DNS — the API's public edge ───────────────────────────────────────────────
# Cloudflare-proxied (orange cloud): the ALB security group in runtime-<env> only
# admits Cloudflare edge ranges, so a grey-clouded record would simply time out.
module "dns_api" {
  source = "git::https://github.com/quynhonsemiconductor/qnsc-tf-modules.git//modules/dns-record?ref=dns-record-v1.1.0"

  enabled = local.cloudflare_zone_id != ""
  zone_id = local.cloudflare_zone_id
  name    = var.api_record
  type    = "CNAME"
  # Tunnel or ALB, and the CNAME target is the whole difference:
  #   tunnel — <tunnel-id>.cfargotunnel.com, a Cloudflare-internal name that resolves
  #            only through the edge. It CANNOT be grey-clouded: an orange-cloud record
  #            is the only way traffic reaches a connector. Read from module.tunnel's
  #            own output rather than built from a manually-tracked id, since Terraform
  #            now owns the tunnel outright.
  #   ALB    — the load balancer's public DNS name (null today; see module.tunnel_api).
  content = var.tunnel_enabled ? one(module.tunnel[*].cname) : try(data.terraform_remote_state.runtime.outputs.alb_dns_name, "")
  proxied = true
  comment = "${local.name} API → ALB via Cloudflare proxy (managed by ${var.product}-infra ${var.env})"
}

# ── Guard: the OTel/FireLens sidecars must watch the log group the app actually
# writes to ────────────────────────────────────────────────────────────────────
# Mirrors rally's stack module exactly. ENFORCED as a resource precondition, not a
# `check` block — a violated check emits a warning and the plan exits 0, which
# would leave a collector silently pointed at the wrong log group, exactly what
# this guard exists to prevent.
#
# `terraform_data` rather than a variable validation, because the condition reads
# `local.*` and a module output, which a validation block cannot. `input` is bound
# to the guarded values so the precondition re-evaluates whenever they change,
# not only on first create.
resource "terraform_data" "otel_agent_log_groups_match_services" {
  input = {
    api    = local.api_log_group
    worker = local.worker_log_group
  }

  lifecycle {
    precondition {
      condition     = local.api_log_group == module.api.log_group_name
      error_message = "api sidecar log group '${local.api_log_group}' != '${module.api.log_group_name}'. ecs-service changed its log-group naming; update local.api_log_group."
    }

    precondition {
      condition     = local.worker_log_group == module.worker.log_group_name
      error_message = "worker sidecar log group '${local.worker_log_group}' != '${module.worker.log_group_name}'. ecs-service changed its log-group naming; update local.worker_log_group."
    }
  }
}

# ── Guard: the pool arithmetic must fit the instance ──────────────────────────
# `local.api_pool_max` / `worker_pool_max` divide a connection budget by the
# AUTOSCALER'S CEILING, so the arithmetic only holds while both ceilings and the
# instance class stay in step. Raising a max_count shrinks the per-task pool to
# compensate, which is correct; shrinking the RDS class moves the budget under both.
#
# Worth an assertion rather than a comment because the failure is invisible in a plan
# and indirect at runtime — requests stall for `connectionTimeoutMillis` rather than
# anything reporting "out of connections".
# ENFORCED as a resource precondition, not a `check` block. A violated check emits
# `Warning: Check block assertion failed` and the plan exits 0 — so as a check this guard
# reported a problem nobody would see in CI output and applied anyway. The condition reads
# `local.*`, which a variable validation cannot, hence `terraform_data` rather than moving it
# to variables.tf with the other three.
#
# `input` is bound to the guarded values so the precondition is re-evaluated whenever they
# change, rather than only on first create — verified that a violation fails a plan even when
# the resource already exists in state.
#
# Left as a check in #116 on the grounds that it "needs a lifecycle precondition and is worth
# its own change"; rally then did exactly that in quynhonsemiconductor/rally#392, so this closes the gap
# rather than leaving the two repos with different mechanisms for the same guard.
resource "terraform_data" "db_pool_fits_instance_class" {
  input = {
    api    = var.api.max_count * local.api_pool_max
    worker = var.worker.max_count * local.worker_pool_max
    budget = local.db_pool_budget
  }

  lifecycle {
    precondition {
      condition = (var.api.max_count * local.api_pool_max
      + var.worker.max_count * local.worker_pool_max) <= local.db_pool_budget
      error_message = join(" ", [
        "DB pool ceiling exceeds the budget for ${var.rds.instance_class}:",
        "api ${var.api.max_count}x${local.api_pool_max}",
        "+ worker ${var.worker.max_count}x${local.worker_pool_max}",
        "> ${local.db_pool_budget} usable of ${local.db_max_connections}.",
        "Lower a max_count or move to a larger instance class.",
      ])
    }
  }
}

# ── Idling: stop the database AND scale the services to zero ──────────────────
# One mechanism, two uses: an environment parked before go-live, and off-hours on
# develop if that is ever wanted.
#
# BOTH halves, because stopping only the database leaves Fargate tasks running against
# an instance they cannot reach — still billed, unable to serve, and invisible, since
# `/v1/healthz` answers 200 whether or not Postgres is reachable.
#
# EventBridge Scheduler's universal target calls the AWS API directly: no Lambda to own,
# patch or pay for.
resource "aws_iam_role" "idler" {
  count = var.idle_schedule == null ? 0 : 1
  name  = "${local.name}-idler"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
      # Confused-deputy guard: without it, any other account's schedule could assume this
      # role. Scoped to this account's schedules only.
      Condition = { StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id } }
    }]
  })

  tags = local.tags
}

resource "aws_iam_role_policy" "idler" {
  count = var.idle_schedule == null ? 0 : 1
  name  = "idle-environment"
  role  = aws_iam_role.idler[0].id

  # Stop only — not Start, not Reboot. The schedule's whole job is to REMOVE capacity, and
  # a role that can also start an instance turns a scheduling mistake into a cost
  # increase. Waking is the deploy pipeline's job and carries its own grant.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "StopDatabase"
        Effect   = "Allow"
        Action   = "rds:StopDBInstance"
        Resource = module.rds.instance_arn
      },
      {
        Sid    = "ScaleServicesToZero"
        Effect = "Allow"
        Action = "ecs:UpdateService"
        Resource = [
          module.api.service_arn,
          module.worker.service_arn,
        ]
      },
    ]
  })
}

resource "aws_scheduler_schedule" "rds_stop" {
  count       = var.idle_schedule == null ? 0 : 1
  name        = "${local.name}-rds-stop"
  description = "Stops ${module.rds.identifier}; see var.idle_schedule for why this exists"

  schedule_expression          = var.idle_schedule
  schedule_expression_timezone = "Asia/Ho_Chi_Minh"

  # OFF, not a window: this is not load-sensitive work, and an exact time keeps the
  # relationship between a run and its CloudTrail entry unambiguous.
  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = "arn:aws:scheduler:::aws-sdk:rds:stopDBInstance"
    role_arn = aws_iam_role.idler[0].arn
    input    = jsonencode({ DbInstanceIdentifier = module.rds.identifier })

    # No retries and no dead-letter queue ON PURPOSE. The common outcome is
    # InvalidDBInstanceState because the instance is ALREADY STOPPED — the desired state,
    # not an error. Retrying would generate noise for a success and a DLQ would collect
    # messages nobody should act on. A genuine permissions failure still shows in
    # CloudTrail and in the schedule's own metrics.
    retry_policy {
      maximum_retry_attempts = 0
    }
  }
}

# Scale the services to zero on the same cadence as the database stop.
#
# `desired_count` is under `ignore_changes` in the ecs-service module, so setting it out
# of band is the sanctioned, non-drifting mechanism — which is why this uses
# ecs:UpdateService rather than an autoscaling scheduled action. A scheduled action would
# mutate the scalable target's min/max, and `aws_appautoscaling_target` has no
# `ignore_changes` on those, so every plan would show drift and any apply during the idle
# window would silently wake the environment.
#
# A floor of 0 is what makes this hold: with min_count = 1, Application Auto Scaling
# restores the service within minutes. `enable_autoscaling = false` is the other way.
resource "aws_scheduler_schedule" "ecs_scale_down" {
  for_each = var.idle_schedule == null ? {} : {
    api    = module.api.service_name
    worker = module.worker.service_name
  }

  name        = "${local.name}-${each.key}-scale-down"
  description = "Scales ${each.value} to zero; see var.idle_schedule"

  schedule_expression          = var.idle_schedule
  schedule_expression_timezone = "Asia/Ho_Chi_Minh"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = "arn:aws:scheduler:::aws-sdk:ecs:updateService"
    role_arn = aws_iam_role.idler[0].arn
    input = jsonencode({
      Cluster      = module.ecs_cluster.cluster_name
      Service      = each.value
      DesiredCount = 0
    })

    # Idempotent — scaling an already-zero service to zero succeeds — so unlike the RDS
    # stop there is no expected-failure case. Retries stay off for consistency; a missed
    # run is corrected by the next tick.
    retry_policy {
      maximum_retry_attempts = 0
    }
  }
}
# ── Ingress health, from OUTSIDE AWS ─────────────────────────────────────────
# Created only when the api is TUNNELLED and `monitor_ingress` is on, and it exists to
# replace something real.
#
# With an ALB, `monitor_target_health` watched UnHealthyHostCount. A tunnelled task has no
# target group, so that alarm cannot exist — and nothing else on the AWS side observes
# ingress at all:
#
#   - ECS reports the task RUNNING whether or not cloudflared holds edge connections.
#   - `essential = true` on the sidecar catches the connector CRASHING, not it staying up
#     with zero edge connections.
#   - An ECS healthCheck cannot probe it either: the cloudflared image is distroless, so
#     there is no shell for a CMD-SHELL probe.
#
# A Route 53 health check probes the PUBLIC hostname from outside AWS, so it exercises the
# whole path a user takes — Cloudflare edge, tunnel, connector, app — rather than asking ECS
# whether it thinks the task is fine.
#
# No Route 53 HOSTED ZONE is involved: DNS is Cloudflare, and a health check is a standalone
# resource. This adds no zone.
#
# BOTH gates are required. `tunnel_enabled` says the ALB alarm cannot do this job;
# `monitor_ingress` says there is something running worth watching. See the variable for why
# the second defaults to false here while rally defaults it true.
locals {
  # An environment whose service floors are 0 spends most of its time at zero tasks, and a
  # health check against a hostname with nothing behind it sits in ALARM for every one of
  # those hours. That is the same argument this stack already makes for the LOAD alarms
  # (`environment_idle` on the observability module): a floor of 0 is exactly what makes an
  # alarm about serving traffic meaningless.
  #
  # DERIVED rather than left to the variable, so "turn it on when you raise min_count" is
  # automatic instead of a thing to remember — the difference between a rule and a hope.
  environment_idle = var.api.min_count == 0 && var.worker.min_count == 0

  monitor_ingress = var.tunnel_enabled && var.monitor_ingress && !local.environment_idle
}

resource "aws_route53_health_check" "api_ingress" {
  count = local.monitor_ingress ? 1 : 0

  fqdn              = var.api_domain
  type              = "HTTPS"
  port              = 443
  resource_path     = "/v1/healthz"
  failure_threshold = 3
  request_interval  = 30

  # Left OFF: latency measurement is a paid option and this alarm only needs up/down. Same
  # for string matching — /v1/healthz answering 200 is the signal.
  measure_latency = false

  tags = merge(local.tags, { Name = "${local.name}-api-ingress" })
}

# The alarm must live in us-east-1: AWS/Route53 HealthCheckStatus is published only there,
# regardless of where the endpoint is.
resource "aws_cloudwatch_metric_alarm" "api_ingress_down" {
  count    = local.monitor_ingress ? 1 : 0
  provider = aws.us_east_1

  alarm_name        = "${local.name}-api-ingress-down"
  alarm_description = "${var.api_domain} is not answering /v1/healthz from outside AWS. With no ALB this is the only ingress alarm — check the cloudflared sidecar's edge connections first."

  namespace           = "AWS/Route53"
  metric_name         = "HealthCheckStatus"
  dimensions          = { HealthCheckId = aws_route53_health_check.api_ingress[0].id }
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "LessThanThreshold"

  # Missing data is NOT breaching here. The health checker itself is the reporter, so a gap
  # in its own metric is far more likely to be a Route 53 reporting hiccup than an outage —
  # treating it as breaching would page on the monitoring rather than the service.
  treat_missing_data = "missing"

  alarm_actions = [aws_sns_topic.ingress_alarms_us_east_1[0].arn]
  ok_actions    = [aws_sns_topic.ingress_alarms_us_east_1[0].arn]

  tags = local.tags
}

# A CloudWatch alarm action must be an SNS topic in the ALARM's own region, so the
# ap-southeast-1 topic the observability module owns cannot be used here. This one mirrors
# it, and costs nothing until it publishes.
resource "aws_sns_topic" "ingress_alarms_us_east_1" {
  count    = local.monitor_ingress ? 1 : 0
  provider = aws.us_east_1

  name = "${local.name}-ingress-alarms"
  tags = local.tags
}

resource "aws_sns_topic_subscription" "ingress_alarms_email" {
  for_each = local.monitor_ingress ? toset(var.alarm_emails) : toset([])
  provider = aws.us_east_1

  topic_arn = aws_sns_topic.ingress_alarms_us_east_1[0].arn
  protocol  = "email"
  endpoint  = each.value
}



# ── Waking (the reverse of idling) ────────────────────────────────────────────
# Starts the database and restores both services on a cron. See var.wake_schedule for why
# this exists at all — the short version is that "the deploy pipeline is the wake signal"
# covers the days the environment is CHANGED but not the days it is merely USED, and RDS
# takes 4-5 minutes to come up, so someone who finds it stopped cannot wait it out.
#
# A SEPARATE ROLE from the idler, which is the whole point. The idler's policy says in its
# own comment that it is stop-only because "a role that can also start an instance turns a
# scheduling mistake into a cost increase". That is still true, so the start grants live here
# rather than being added there: a fault in the wake cron can cost money, a fault in the idle
# cron can cost availability, and neither can now cause the other.
resource "aws_iam_role" "waker" {
  count = var.wake_schedule == null ? 0 : 1
  name  = "${local.name}-waker"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
      # Same confused-deputy guard as the idler.
      Condition = { StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id } }
    }]
  })

  tags = local.tags
}

resource "aws_iam_role_policy" "waker" {
  count = var.wake_schedule == null ? 0 : 1
  name  = "wake-environment"
  role  = aws_iam_role.waker[0].id

  # Start only, mirroring the idler's stop-only. No rds:StopDBInstance here, and no
  # DeleteDBInstance or RebootDBInstance — this role's entire job is to add capacity back.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "StartDatabase"
        Effect   = "Allow"
        Action   = "rds:StartDBInstance"
        Resource = module.rds.instance_arn
      },
      {
        Sid    = "RestoreServices"
        Effect = "Allow"
        Action = "ecs:UpdateService"
        Resource = [
          module.api.service_arn,
          module.worker.service_arn,
        ]
      },
    ]
  })
}

resource "aws_scheduler_schedule" "rds_start" {
  count       = var.wake_schedule == null ? 0 : 1
  name        = "${local.name}-rds-start"
  description = "Starts ${module.rds.identifier}; see var.wake_schedule for why this exists"

  schedule_expression          = var.wake_schedule
  schedule_expression_timezone = "Asia/Ho_Chi_Minh"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = "arn:aws:scheduler:::aws-sdk:rds:startDBInstance"
    role_arn = aws_iam_role.waker[0].arn
    input    = jsonencode({ DbInstanceIdentifier = module.rds.identifier })

    # Mirror of the stop schedule: starting an already-started instance fails with
    # InvalidDBInstanceState, which is the DESIRED state and not an error. No retries and no
    # DLQ, for the same reason.
    retry_policy {
      maximum_retry_attempts = 0
    }
  }
}

# Restore both services on the same cadence as the database start.
#
# DesiredCount is a literal 1, NOT var.api.min_count — see var.wake_schedule. The floors are
# 0 in an idled environment and have to stay 0, or Application Auto Scaling undoes the idle
# within minutes. 1 is the count the deploy pipeline sets, so a wake and a deploy agree on
# one answer.
#
# The tasks come up before RDS finishes starting and will fail readiness for a few minutes.
# That is accepted: ECS keeps replacing them and they settle once postgres answers, which is
# the same behaviour a deploy-triggered wake already produces. Sequencing the two would need
# a state machine, for a few minutes of 503 on an environment nobody is paged for.
resource "aws_scheduler_schedule" "ecs_scale_up" {
  for_each = var.wake_schedule == null ? {} : {
    api    = module.api.service_name
    worker = module.worker.service_name
  }

  name        = "${local.name}-${each.key}-scale-up"
  description = "Restores ${each.value} to 1 task; see var.wake_schedule"

  schedule_expression          = var.wake_schedule
  schedule_expression_timezone = "Asia/Ho_Chi_Minh"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = "arn:aws:scheduler:::aws-sdk:ecs:updateService"
    role_arn = aws_iam_role.waker[0].arn
    input = jsonencode({
      Cluster      = module.ecs_cluster.cluster_name
      Service      = each.value
      DesiredCount = 1
    })

    retry_policy {
      maximum_retry_attempts = 0
    }
  }
}

# ── Guard: an environment without a cache must run no tasks ───────────────────
# `cache.enabled = false` deletes the node, and ElastiCache has no stopped state, so it
# is the only way to stop an idled environment paying for one. But a task that cannot
# reach its cache does NOT fail loudly here: REDIS_URL is optional in the app's env
# schema, and the token denylist and the rate limiter both FAIL OPEN when Valkey is
# unreachable. So the dangerous state is not "no cache" — it is "no cache, tasks
# running", which degrades two security controls silently.
#
# Asserting it here makes that combination unreachable through Terraform: the plan fails
# instead of producing an environment that looks healthy. Waking an idled environment is
# therefore one coherent change — cache back on, floors back to 1 — rather than two that
# can be applied in the wrong order.
# ── Alarms, alert topic and dashboard ─────────────────────────────────────────
# CloudWatch alarms for ECS (CPU, memory), RDS (CPU, connections, free storage) and — with an
# ALB — per-target-group latency and unhealthy hosts. The module also OWNS the alert topic, so
# there is exactly one topic and one subscription to confirm per environment.
#
# Adopted from rally. opshub had no alarms at all, which is the state where an outage is
# discovered by a person rather than by a page.

# ── Burstable-RDS alarm sizing, keyed by instance class ──────────────────────
# opshub runs `db.t4g.micro` in BOTH environments (infra/live/develop/main.tf and
# infra/live/prod/main.tf), so both of the observability module's opt-in burstable alarms
# apply here and both get a real floor. This is not an assumption inherited from rally —
# it was read off opshub's own live files.
#
# Why these alarms matter to this product in particular: a burstable class does not fail
# under sustained load, it DEGRADES, and neither of those degradations is visible to the
# CPU, connection-count or storage alarms already created. A credit-throttled instance
# sits pinned at its baseline percentage, so `CPUUtilization` reads healthy while every
# query slows; a memory-starved one loses its filesystem cache and reads fall through to
# EBS. Both surface downstream as application p99 latency — which is exactly the alert
# that just paged rally with an uninterpretable value, and exactly the alert this change
# has now made quieter. Removing noise from the symptom while leaving the cause unalarmed
# would be a net loss of coverage, so the two halves belong in one change.
#
# KEYED BY CLASS rather than written as two constants, because a correct floor is a
# function of the instance class and opshub has a DOCUMENTED plan to change it: prod's
# GO-LIVE CHECKLIST in infra/live/prod/main.tf calls for `db.t4g.small`. Two constants
# would survive that flip while quietly becoming wrong — 200 MB is a 20% memory floor on
# 1 GiB and a 10% floor on 2 GiB.
#
# Only the class opshub actually runs is populated, on purpose. The precondition below
# fails the plan for any other class rather than falling back to a default, so the go-live
# flip to `db.t4g.small` cannot land until someone sizes it against the AWS T4g credit
# table. Inventing numbers here for classes nobody has sized would defeat the guard: a
# plausible-looking wrong floor is worse than a failed plan, because the plan gets fixed.
#
# A non-burstable class (`db.m*`, `db.r*`) belongs in this map too when one is adopted,
# with `cpu_credit_min = 0`. Those classes never publish `CPUCreditBalance` at all, so a
# non-zero floor would create an alarm that parks in INSUFFICIENT_DATA forever and reads
# as coverage — the same trap `rds_instance_id`'s own validation exists to prevent.
locals {
  rds_burst_alarm_thresholds_by_class = {
    # 1 GiB of RAM; earns 24 CPU credits/hour against a 576-credit maximum.
    #
    # 100 credits is roughly four hours of accumulated burst still in hand, which is
    # enough warning to shed load or resize before throttling starts rather than a page
    # that arrives once the instance is already pinned at baseline. Taken from the
    # observability module README's own worked example for this exact class, so the number
    # is the organisation's, not this file's.
    #
    # 200 MB freeable is a 20% floor on 1 GiB. Below that PostgreSQL is already giving up
    # filesystem cache, which is the earliest point the degradation is both real and still
    # cheap to act on. MEGABYTES, not bytes — the module converts, and the unit is in the
    # variable name precisely so a nine-digit constant never has to appear at a call site.
    "db.t4g.micro" = {
      cpu_credit_min     = 100
      freeable_memory_mb = 200
    }
  }
  rds_burst_alarm_thresholds = lookup(
    local.rds_burst_alarm_thresholds_by_class,
    var.rds.instance_class,
    { cpu_credit_min = 0, freeable_memory_mb = 0 },
  )
}

# Guarded as a precondition for the same reason as the two guards above: the fallback in
# that `lookup` is `0`/`0`, which the module reads as "do not create the alarm". Without
# this assertion, changing the instance class would DELETE two production alarms silently
# and the plan would show it as an ordinary destroy among many. Failing the plan makes
# sizing the new class a required step of the resize rather than a follow-up nobody files.
resource "terraform_data" "rds_burst_alarms_sized_for_instance_class" {
  input = {
    instance_class = var.rds.instance_class
    thresholds     = local.rds_burst_alarm_thresholds
  }

  lifecycle {
    precondition {
      condition = contains(
        keys(local.rds_burst_alarm_thresholds_by_class),
        var.rds.instance_class,
      )
      error_message = join(" ", [
        "No burstable-alarm sizing for ${var.rds.instance_class}.",
        "CPUCreditBalance and FreeableMemory floors depend on the class, so changing it",
        "without adding an entry to local.rds_burst_alarm_thresholds_by_class would drop",
        "both alarms to their 0 default and delete them.",
        "Add the class with a sized floor (or cpu_credit_min = 0 if it is not burstable).",
        "Sized so far: ${join(", ", keys(local.rds_burst_alarm_thresholds_by_class))}.",
      ])
    }
  }
}

module "observability" {
  # observability-v4.3.0 adds the two opt-in burstable RDS alarms wired below
  # (`thresholds.rds_cpu_credit_min`, `thresholds.rds_freeable_memory_mb`). Additive and
  # both defaulting to 0, so the bump is a minor version and is a no-op for every other
  # caller of this module.
  #
  # THIS TAG DOES NOT EXIST YET — it must be cut in qnsc-tf-modules before this plans.
  source = "git::https://github.com/quynhonsemiconductor/qnsc-tf-modules.git//modules/observability?ref=observability-v4.3.0"

  create_dashboard = var.create_dashboard

  name              = local.name
  region            = var.region
  ecs_cluster_name  = module.ecs_cluster.cluster_name
  ecs_service_names = [module.api.service_name, module.worker.service_name]

  # Node mode only (var.cache.mode default), null for serverless — same guard
  # rally's stack uses. opshub's cache is always its own dedicated node/instance
  # per environment (no shared-node concept here), so this is always safe to
  # wire when the cache is enabled at all.
  #
  # enable_cache_alarms is a SEPARATE, plan-time-known condition from
  # cache_cluster_id's value: on this environment's first-ever apply the cache
  # node doesn't exist yet, so module.cache[0].cluster_id is unknown-until-apply,
  # and a count gated on that directly is a hard OpenTofu error, not a deferred
  # plan (see observability-v4.2.1's own changelog). This condition is known at
  # plan time regardless.
  enable_cache_alarms = var.cache.enabled && var.cache.mode == "node"
  cache_cluster_id    = var.cache.enabled && var.cache.mode == "node" ? module.cache[0].cluster_id : ""

  # Empty while the api is tunnelled: the shared ALBs were deleted when both products moved to
  # tunnels, so `runtime.outputs.alb_arn` is absent and the two ALB alarms have nothing to read.
  alb_arn = var.tunnel_enabled ? "" : try(data.terraform_remote_state.runtime.outputs.alb_arn, "")

  # `identifier` (opshub-dev), NOT `instance_id` (db-XXXX…). CloudWatch publishes RDS metrics
  # under the DBInstanceIdentifier dimension, and passing the resource id leaves the RDS alarms
  # in INSUFFICIENT_DATA permanently while appearing covered — a trap rally fell into for six
  # alarms across both environments. observability-v3.0.0+ rejects a resource id outright, so
  # this fails the plan rather than regressing silently.
  rds_instance_id = module.rds.identifier

  # The FIRST thresholds passthrough in this module — every other key keeps the module's
  # default, which is deliberate and unchanged. Only the two burstable alarms are set,
  # because they are the only two that default OFF and therefore the only two that a
  # caller has to opt into. See local.rds_burst_alarm_thresholds_by_class above for the
  # sizing argument and the precondition that keeps it honest across a class change.
  thresholds = {
    rds_cpu_credit_min     = local.rds_burst_alarm_thresholds.cpu_credit_min
    rds_freeable_memory_mb = local.rds_burst_alarm_thresholds.freeable_memory_mb
  }

  # No target groups while tunnelled, so the latency and UnHealthyHostCount alarms are not
  # created. See `monitor_target_health` — that is a real gap to close from outside AWS, not
  # just plumbing, because with no ALB nothing on the AWS side observes ingress at all.
  target_group_arns     = var.tunnel_enabled ? {} : { api = module.api.target_group_arn }
  monitor_target_health = var.monitor_target_health

  # Suppresses the alarms whose premise is "this environment is serving traffic" — ECS CPU and
  # memory, ALB 5xx, unhealthy hosts.
  #
  # Derived from the idle posture rather than being its own switch: an environment whose
  # services have a floor of 0 is exactly one that cannot support a load alarm. A service
  # scaled to zero makes its CPU metric DISAPPEAR rather than read zero, so the alarm would
  # walk OK -> INSUFFICIENT_DATA -> OK on every wake and mail an OK notice each time. Tying it
  # to the floors means restoring capacity re-arms the alarms in the same change.
  environment_idle = local.environment_idle

  alarm_emails = var.alarm_emails
  tags         = local.tags
}

# ── Alerting: security controls that failed OPEN ──────────────────────────────
# The access-token denylist (JwtAuthGuard) and the rate limiter both fail open when Valkey
# is unreachable. Each choice is right on its own — an outage should not lock every user
# out, and rate limiting is protective rather than load-bearing — but TOGETHER a cache
# outage accepts revoked tokens AND serves unlimited traffic, with nothing watching.
#
# Log-based rather than OTel-based, deliberately: `OTEL_ENABLED` is false until
# `observability.otlp_endpoint` is set, so a counter would report nothing while looking
# like monitoring. Container logs reach CloudWatch regardless of the OTel path.
#
# The field comes from `FAIL_OPEN_FIELD` in @qnsc-vn/observability, emitted by
# `failOpenLog()` at the two guards. Renaming it there would silently disarm this filter,
# so libs/platform/src/observability/fail-open.spec.ts greps THIS file for the pattern and
# fails if the two disagree.
resource "aws_cloudwatch_log_metric_filter" "security_fail_open" {
  name           = "${local.name}-security-fail-open"
  log_group_name = module.api.log_group_name
  pattern        = "{ $.securityFailOpen = \"*\" }"

  metric_transformation {
    name          = "SecurityFailOpen"
    namespace     = "${var.product}/${var.env}"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "security_fail_open" {
  alarm_name        = "${local.name}-security-fail-open"
  alarm_description = "A security control failed open (token denylist or rate limiter) — check Valkey health."

  namespace           = "${var.product}/${var.env}"
  metric_name         = "SecurityFailOpen"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  # A metric filter emits no data points when nothing matches, which IS the healthy state —
  # treat that as OK rather than as INSUFFICIENT_DATA noise.
  treat_missing_data = "notBreaching"

  # NOT gated on `environment_idle` like the load alarms. A fail-open event means a security
  # control degraded, which matters just as much in an environment serving no traffic — and
  # unlike CPU, this metric does not disappear when a service scales to zero.
  alarm_actions = [module.observability.alarm_topic_arn]
  ok_actions    = [module.observability.alarm_topic_arn]
}

# ── Outbox dead-letter ────────────────────────────────────────────────────────
#
# The WORKER's log group, not the api's: every relay runs there. `outboxDeadLetter` is
# emitted by AbstractOutboxRelay when a row exhausts maxAttempts, which is silent work
# loss — an email nobody receives, a notification nobody sees, a webhook that never
# fired. The field exists so a metric filter can match a STRUCTURED key; matching prose
# would break the day someone rewords the log line.
#
# Until this existed the field was greppable and nothing more: three relays emitted it
# and no alarm watched it. Ported from rally, where it is the same pair.
resource "aws_cloudwatch_log_metric_filter" "outbox_dead_letter" {
  name           = "${local.name}-outbox-dead-letter"
  log_group_name = module.worker.log_group_name
  pattern        = "{ $.outboxDeadLetter = \"*\" }"

  metric_transformation {
    name          = "OutboxDeadLetter"
    namespace     = "${var.product}/${var.env}"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "outbox_dead_letter" {
  alarm_name        = "${local.name}-outbox-dead-letter"
  alarm_description = "A relay gave up on a row after exhausting its retries — work has been lost. Query the relevant outbox table for status = 'failed'."

  namespace           = "${var.product}/${var.env}"
  metric_name         = "OutboxDeadLetter"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  # A metric filter emits no data points when nothing matches, which is the healthy
  # state — treat that as OK rather than INSUFFICIENT_DATA noise.
  treat_missing_data = "notBreaching"

  # NOT gated on `environment_idle`. A dead-lettered row is lost work whether or not the
  # environment is serving traffic, and the metric does not vanish when a service scales
  # to zero — the worker had to be running to emit it in the first place.
  alarm_actions = [module.observability.alarm_topic_arn]
  ok_actions    = [module.observability.alarm_topic_arn]
}

# The cache/floors invariant is enforced by a `validation` block on `var.cache` in
# variables.tf, NOT by a `check` block here.
#
# It WAS a check, and the difference is not cosmetic: a violated check assertion emits
# `Warning: Check block assertion failed` and the plan exits 0. Measured on OpenTofu
# 1.12.3 — a check exits 0, a cross-variable variable validation exits 1. The comment this
# replaces claimed "the plan fails instead of producing an environment that looks healthy",
# which described enforcement that did not exist: the forbidden combination would have
# applied cleanly behind a warning nobody reads in CI output.

# ── Outbound email: the permission half ───────────────────────────────────────
#
# WITHOUT `ses:SendEmail` ON THE TASK ROLE, EVERY SEND FAILS `AccessDenied` — before the sender is
# even looked at. The relay's attempts exhaust, the rows dead-letter, and the service goes on
# reporting healthy, so the first symptom is somebody asking why they never got an email. The sibling
# repo ran BOTH of its environments that way for a while, with `EMAIL_PROVIDER=ses` and a correct
# `MAIL_FROM_EMAIL` sitting right beside the missing grant. Shipping the provider without this would
# reproduce that exactly.
#
# SCOPED TWO WAYS, because `ses:SendEmail` on `"*"` would let a compromised task send as any verified
# identity in the account — including another environment's:
#   • `Resource` is this account's identity for the SENDER'S OWN DOMAIN, so one environment cannot
#     send through an identity it does not share.
#   • The `ses:FromAddress` condition pins the envelope sender to exactly `mail_from_email`, so the
#     grant cannot be turned into impersonating another address on the same domain.
#
# THE ARN IS CONSTRUCTED, not read from the identity resource. IAM will happily reference a resource
# that does not exist yet, so verifying the domain and applying this stack can happen in either order
# and the permission simply starts working once verification completes. A data source would make the
# whole stack fail until the identity existed.
#
# `count` on the sender rather than on the provider: the grant is harmless when mail is off, and tying
# it to `email_provider` would mean an apply that flips the provider also has to create the policy,
# turning a config change into a permissions change.
locals {
  mail_domain      = var.mail_from_email == "" ? "" : split("@", var.mail_from_email)[1]
  ses_identity_arn = "arn:aws:ses:${var.region}:${data.aws_caller_identity.current.account_id}:identity/${local.mail_domain}"

  ses_send_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ses:SendEmail", "ses:SendRawEmail"]
        Resource = local.ses_identity_arn
        Condition = {
          StringEquals = { "ses:FromAddress" = var.mail_from_email }
        }
      },
    ]
  })
}

resource "aws_iam_role_policy" "api_ses_send" {
  count  = var.mail_from_email == "" ? 0 : 1
  name   = "${local.name}-api-ses-send"
  role   = split("/", module.api.task_role_arn)[1]
  policy = local.ses_send_policy
}

# The worker relays the outbox, so it sends more mail than the api does. Both need the grant.
resource "aws_iam_role_policy" "worker_ses_send" {
  count  = var.mail_from_email == "" ? 0 : 1
  name   = "${local.name}-worker-ses-send"
  role   = split("/", module.worker.task_role_arn)[1]
  policy = local.ses_send_policy
}

# ── SES bounce/complaint feedback loop ──────────────────────────────────────────
# Mirrors rally's stack module exactly. Unconditional, like rally — a configuration
# set, its SNS topic and its SQS queue cost nothing idle and don't depend on
# mail_from_email being set yet, unlike the send grants above.
#
# Without this, a bounce or complaint SES reports arrives as an event nothing can
# tie back to the message that caused it, and the app keeps sending mail to
# addresses SES already told us are bad — a compliance-relevant failure mode, not
# just a delivery one.
resource "aws_sesv2_configuration_set" "email_feedback" {
  # `configuration_set_name`, not `name`: matches the pinned provider version rally uses.
  configuration_set_name = "${local.name}-email-feedback"
}

resource "aws_sns_topic" "ses_bounce_events" {
  name = "${local.name}-ses-bounce-events"
}

resource "aws_sesv2_configuration_set_event_destination" "bounces" {
  configuration_set_name = aws_sesv2_configuration_set.email_feedback.configuration_set_name
  event_destination_name = "bounce-complaints-to-sqs"

  event_destination {
    enabled              = true
    matching_event_types = ["BOUNCE", "COMPLAINT"]
    sns_destination {
      topic_arn = aws_sns_topic.ses_bounce_events.arn
    }
  }
}

resource "aws_sqs_queue" "ses_bounce_feedback" {
  name = "${local.name}-ses-bounce-feedback"
}

resource "aws_sqs_queue_policy" "ses_bounce_feedback" {
  queue_url = aws_sqs_queue.ses_bounce_feedback.url

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Principal = { Service = "sns.amazonaws.com" }
        Action    = "sqs:SendMessage"
        Resource  = aws_sqs_queue.ses_bounce_feedback.arn
        Condition = {
          ArnEquals = { "aws:SourceArn" = aws_sns_topic.ses_bounce_events.arn }
        }
      },
    ]
  })
}

resource "aws_sns_topic_subscription" "ses_bounce_to_sqs" {
  topic_arn = aws_sns_topic.ses_bounce_events.arn
  protocol  = "sqs"
  endpoint  = aws_sqs_queue.ses_bounce_feedback.arn
}

# If the worker's bounce-feedback consumer stalls (a bug, a permission change, a
# deploy that drops the consumer), events pile up silently: no failed health check,
# no 5xx — the app keeps sending mail to addresses SES already flagged.
resource "aws_cloudwatch_metric_alarm" "ses_bounce_queue_depth" {
  alarm_name          = "${local.name}-ses-bounce-queue-depth-high"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.ses_bounce_feedback.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 3
  threshold           = 100
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [module.observability.alarm_topic_arn]
  tags                = local.tags
}

# The direct "is anyone draining this" signal — depth alone can spike from a real
# burst and clear on its own; age only grows when nothing is consuming.
resource "aws_cloudwatch_metric_alarm" "ses_bounce_queue_stalled" {
  alarm_name          = "${local.name}-ses-bounce-queue-stalled"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  dimensions          = { QueueName = aws_sqs_queue.ses_bounce_feedback.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 3600
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [module.observability.alarm_topic_arn]
  tags                = local.tags
}

# The feedback half of the loop: whichever worker service consumes it long-polls this
# queue. Scoped to the one queue and the three calls a drain makes — Receive, Delete
# (the consumer acks whether or not the event matched a row, so an unmatched event
# can never poison the queue into an unresolvable retry), and GetQueueAttributes for
# the SDK's standard startup probe. No wildcard.
resource "aws_iam_role_policy" "worker_sqs_bounce_feedback" {
  name = "${local.name}-worker-sqs-bounce-feedback"
  role = split("/", module.worker.task_role_arn)[1]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
        Resource = aws_sqs_queue.ses_bounce_feedback.arn
      },
    ]
  })
}

# ── Grafana Alerting + Dashboards ──────────────────────────────────────────────
# Mirrors rally's stack module — same thresholds philosophy (per-env, single
# source of truth shared between the alert condition and the dashboard's threshold
# line), same `or vector(0)`/absent-vector fix on every ratio query (confirmed live
# in rally's own prod: a zero-failure series is ABSENT, not present-at-zero, and
# dividing by an absent vector renders as "No data" instead of the honest 0%).
#
# `db-pool-contention` and its dashboard panel are included for structural parity
# with rally, but stay DARK until `DbPoolMetrics` is wired into opshub's own
# `DatabaseModule` — not done as part of this change (application code, not infra).
# `db_pool_in_use`/`db_pool_waiting` are simply absent metrics until then, so the
# panel shows "No data" and the alert's `no_data_state` (see the module's own
# default) keeps it from paging on that absence.
#
# NO LONGER a byte-for-byte mirror of rally as of this change: the four
# statistically-unsound rules gained a minimum-sample gate and `http-slow-request-count`
# was added. rally carries the same fix for the same defect — see the gate comment below
# for the production page that prompted it.
locals {
  # ── Minimum-sample gates: why four rules carry one ──────────────────────────
  # A percentile over a handful of samples is not a percentile, and a ratio over a
  # handful of samples is not a rate. Both of the affected rule shapes here were
  # capable of paging on a single request.
  #
  # The evidence is a real page on the sibling `rally` product, which runs these SAME
  # rules from this SAME shared module: `http-p99-latency` fired in production with
  # `A=10000` and resolved at `A=48.5`. Neither number is what it looks like:
  #
  #   * `10000` was not a latency. It was the largest FINITE bucket boundary of the
  #     OpenTelemetry JS default histogram, which is what opshub exported at the time, so
  #     `histogram_quantile` had nothing above it to interpolate into and clamped to the
  #     boundary. It meant only "at least one request took longer than 10s" — the true
  #     value could have been 11s or 200s. The same change that added this gate widened
  #     the view out to 60000 (`local.http_duration_buckets_ms` below, mirroring
  #     apps/api/src/otel.ts), so a repeat of that page lands in a bucket that separates
  #     12s from a spent retry budget. The clamp itself is a property of the TOP bucket,
  #     not of the number 10000, and it still applies there.
  #   * `48.5` being the resolve value is the tell. A service does not travel from 10s to
  #     48ms because it recovered; it travels there because the ONE slow sample aged out
  #     of the 5-minute window and left the ordinary traffic behind.
  #
  # Low sample counts are structural here, not incidental. The load-balancer and browser
  # probes that would otherwise pad the histogram are excluded upstream by
  # `IGNORED_REQUEST_PATHS` in @qnsc-vn/observability (`/v1/healthz`, `/v1/readyz`,
  # `/healthz`, `/readyz`, `/favicon.ico`), so a 5-minute window on a quiet environment
  # holds only the handful of genuine requests that arrived. A p99 over one sample IS
  # that sample.
  #
  # THIS ORGANISATION HAS ALREADY FIXED THIS DEFECT ONCE, on the CloudWatch side:
  # `qnsc-tf-modules//modules/observability` gates its `alb_latency` alarm behind
  # `alb_latency_min_requests` (default 50) after a single slow request held that alarm
  # over threshold for three consecutive periods and paged. Its comment is worth quoting
  # because it is the whole argument: noise "trains people to ignore the alarm, which is
  # worse than no alarm." The Grafana rules never got the same treatment. Same bug, one
  # side unfixed until now.
  #
  # WHERE OPSHUB'S NUMBERS COME FROM — and where they do NOT. Unlike rally, opshub has no
  # measured traffic to derive a floor from, because opshub has never served any: per
  # docs/system-roadmap.md `infra/` has never been applied and there is no deployed
  # environment, production is provisioned with `min_count = 0`, autoscaling off and a
  # weekly `idle_schedule`, and develop is schedule-driven (CI deploys and manual pokes).
  # So these are NOT observations, and they are deliberately not presented as such. They
  # are the statistical floor the organisation already sized and shipped on the CloudWatch
  # side — 50 samples per 5-minute period, roughly 1 rps sustained: low enough that any
  # environment under real use clears it, high enough that noise cannot reach a threshold.
  # Develop is set lower at 20 because a CI-driven environment will never sustain 1 rps
  # and a gate it can never clear is a deleted alert, not a quieter one.
  #
  # THE HONEST CONSEQUENCE, stated here rather than discovered during an incident: until
  # go-live these four rules will be largely DARK, because a pre-launch environment
  # cannot clear a traffic floor. That is the correct reading and not a regression —
  # silence below the gate means "not enough samples to judge", never "healthy". The
  # coverage that survives at this traffic level is `http-slow-request-count` below, which
  # is a COUNT and therefore needs no population to be meaningful. Revisit every number
  # in this block at go-live, against the first fortnight of real traffic.
  #
  # Rejected: raising `for` from 5m to 15m instead. That delays the page without fixing
  # it — one slow request in a window of three still holds a p99 above threshold for the
  # whole window, because the problem is the size of the population, not the length of
  # the observation.
  alert_thresholds_by_env = {
    develop = {
      http_error_rate         = 0.05
      http_p99_latency_ms     = 2000
      db_pool_waiting         = 0
      worker_failure_rate     = 0.10
      auth_login_failure_rate = 0.30

      # Requests (or job runs) that must land in a 5-minute window before the p99, the
      # 5xx-rate and the worker-failure-rate rules are allowed to evaluate at all.
      min_samples_5m = 20

      # Login attempts in a 15-minute window, and a SEPARATE key rather than
      # `min_samples_5m * 3` on purpose. Logins are a different population from HTTP
      # requests by roughly two orders of magnitude: reusing the HTTP floor would demand
      # 60 attempts here (150 in production, about 10 per minute) which an internal tool
      # will not sustain, and a gate that never opens would silently disarm a SECURITY
      # alert. That is a worse outcome than the noise being removed, and it would
      # contravene the rule that no existing alert gets weakened.
      #
      # 10 attempts against develop's 30% threshold: one mistyped password is 10%, so a
      # single typo cannot page, but four genuine failures still can.
      min_login_attempts_15m = 10

      # The `le` boundary that `http-slow-request-count` subtracts at, in milliseconds.
      # MUST be an actually-exported bucket boundary — see
      # `local.http_duration_buckets_ms` and the precondition that enforces it.
      #
      # 2500 rather than 2000. Develop's own p99 threshold is 2000ms, but 2000 is NOT a
      # boundary in the exported set and a `le="2000"` selector would match no series
      # at all — a rule that quietly never fires while appearing to be coverage. 2500 is
      # the next real boundary ABOVE the threshold. Snapped up rather than down to 1000
      # deliberately: 1000 would count requests that develop's own p99 rule considers
      # perfectly acceptable, so the count rule would contradict the latency rule.
      slow_request_bucket_ms = 2500

      # Slow requests permitted in a 30-minute window before the count rule fires.
      # Per-env like everything else in this block so production can tighten it at
      # go-live without touching the rule body.
      slow_request_count_30m = 3
    }
    production = {
      http_error_rate         = 0.02
      http_p99_latency_ms     = 1000
      db_pool_waiting         = 0
      worker_failure_rate     = 0.05
      auth_login_failure_rate = 0.15

      # 50, the figure `alb_latency_min_requests` already ships as its default on the
      # CloudWatch side. Sanity-checked against this environment's own thresholds: at 50
      # requests a single 5xx is exactly 2%, and the rule compares with `gt`, so one
      # error cannot page — two can.
      min_samples_5m = 50

      # 20 attempts against production's 15% threshold: one mistyped password is 5%, well
      # under the threshold, while three genuine failures out of 20 is 15% and a fourth
      # pages. See develop's note above for why this is not derived from min_samples_5m.
      min_login_attempts_15m = 20

      # 1000ms, which is BOTH this environment's own p99 threshold and a real boundary in
      # the exported set — the one case where no snapping is needed.
      slow_request_bucket_ms = 1000

      slow_request_count_30m = 3
    }
  }
  alert_thresholds = lookup(local.alert_thresholds_by_env, var.env, local.alert_thresholds_by_env.develop)

  # The explicit bucket boundaries of `http_server_duration_milliseconds`, in the
  # instrument's own unit (milliseconds — `http.server.duration` is declared `unit: 'ms'`,
  # which is why the Prometheus exposition names it
  # `http_server_duration_milliseconds_bucket`).
  #
  # Written out rather than assumed because the whole `A=10000` misreading above comes
  # from not knowing this list, and because `slow_request_bucket_ms` is only meaningful as
  # a member of it.
  #
  # MIRRORS apps/api/src/otel.ts, and is NOT the SDK defaults any more. The same change
  # that added the volume gate passed `httpDurationBoundaries` to `startOtel`, because a
  # top finite bucket of 10000 is exactly where a slow request goes to hide. The first
  # fifteen entries are the OTel JS defaults verbatim, so the low end a healthy p99 sits
  # in is untouched; the four above 10000 cover opshub's real request-path timeout
  # budgets. BOTH LISTS MOVE TOGETHER OR NEITHER MOVES — nothing here can detect a
  # boundary edited on only one side, and the precondition below would then assert
  # against a set nobody exports.
  #
  # Note what is still NOT here: 2000, 3000, 1500. Those are the round numbers an
  # operator reaches for, and every one of them selects nothing.
  http_duration_buckets_ms = [
    0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000,
    15000, 30000, 45000, 60000,
  ]

  runbook_base_url = "https://github.com/quynhonsemiconductor/opshub/blob/main/docs/runbooks/alerts"

  slo_success_objective_by_env = {
    develop    = 0.99
    production = 0.995
  }
  slo_success_objective = lookup(local.slo_success_objective_by_env, var.env, local.slo_success_objective_by_env.develop)
}

# ── Guard: the slow-request bucket must be a boundary that actually exists ────
# `http-slow-request-count` selects a histogram series by an exact `le` label value. A
# value that is not an exported boundary does not fail, warn, or read zero — it matches
# NO SERIES, so the subtraction yields an empty vector and the rule sits permanently
# silent while every dashboard and every review reads it as coverage. That is the same
# failure mode as passing an RDS resource id where CloudWatch wants the identifier: it
# looks monitored and is not.
#
# The trap is specific and easy to fall into: `http_p99_latency_ms` is 2000 on develop,
# so the obvious move is to reuse it as the `le` value, and 2000 is not a boundary. Only
# production's 1000 happens to be one. So the two values cannot simply be the same
# number, and the difference has to be enforced rather than remembered.
#
# ENFORCED as a resource precondition rather than a `check` block, for the reason
# `db_pool_fits_instance_class` above already documents: a violated check prints a
# warning and the plan still exits 0, which puts the problem somewhere nobody looks. A
# variable validation cannot be used either, since the condition reads `local.*`. `input`
# is bound to the guarded values so the precondition re-evaluates whenever they change
# rather than only on first create.
resource "terraform_data" "slow_request_bucket_is_exported_boundary" {
  input = {
    bucket_ms = local.alert_thresholds.slow_request_bucket_ms
    p99_ms    = local.alert_thresholds.http_p99_latency_ms
  }

  lifecycle {
    precondition {
      condition = contains(
        local.http_duration_buckets_ms,
        local.alert_thresholds.slow_request_bucket_ms,
      )
      error_message = join(" ", [
        "slow_request_bucket_ms for ${var.env} is ${local.alert_thresholds.slow_request_bucket_ms},",
        "which is not an exported histogram bucket boundary.",
        "A le= selector on a non-boundary matches no series, so the rule would never fire.",
        "Pick one of: ${join(", ", [for b in local.http_duration_buckets_ms : tostring(b)])}.",
      ])
    }

    # Second, independent guard: the boundary must not sit BELOW this environment's own
    # p99 threshold. If it did, the count rule would page for requests the latency rule
    # is deliberately willing to accept, and the two rules would disagree about what
    # "slow" means in the same environment. Snapping the boundary UP to the next
    # available one is always the correct resolution.
    precondition {
      condition = local.alert_thresholds.slow_request_bucket_ms >= local.alert_thresholds.http_p99_latency_ms
      error_message = join(" ", [
        "slow_request_bucket_ms (${local.alert_thresholds.slow_request_bucket_ms}ms) is below",
        "http_p99_latency_ms (${local.alert_thresholds.http_p99_latency_ms}ms) in ${var.env}.",
        "http-slow-request-count would then count requests that http-p99-latency treats as",
        "acceptable. Snap the bucket UP to the next exported boundary above the threshold.",
      ])
    }
  }
}

# The minimum-sample gate is composed INTO each promql below rather than added as an input
# to the observability-alerts module. That module's README states the constraint plainly —
# "`promql` used verbatim, no label injection", because "string surgery on arbitrary
# PromQL to inject a label filter is exactly the kind of hidden magic that silently breaks
# on a query shape nobody tested". A gate injected by the module would be that magic, and
# these five queries have five different shapes, so it would break here first. The gate is
# therefore visible at the call site, where a reviewer reads it next to the query it
# guards.
#
# THE GATE'S LABEL-SET SEMANTICS, checked per rule rather than assumed, since `and on()`
# silently yields an empty vector when the two sides do not match:
#
#   * `and` binds LOOSER than `/` and looser than `>=` in PromQL, so
#     `A / B and on() (C * 300 >= N)` groups as `(A / B) and on() ((C * 300) >= N)`. The
#     parentheses below are for the reader, not for the parser.
#   * `http-p99-latency`: `sum(...) by (le)` is consumed by `histogram_quantile`, which
#     drops `le` and leaves a single series with NO labels.
#   * the three ratio rules: `sum()` without `by` is unlabelled, and dividing unlabelled
#     by unlabelled stays unlabelled.
#   * the gate side: `sum(rate(...)) * 300 >= N` is unlabelled, and the comparison acts as
#     a FILTER, so the gate is either one unlabelled series or empty.
#
# Both sides therefore carry the empty label set on all four rules, `on()` matches on the
# empty set, and `and` passes the left series through exactly when the gate is non-empty.
# `and on()` is correct for all four; no rule needed a different form.
#
# The window in each gate MATCHES its rule's own window, and the multiplier converts the
# per-second rate back to a count over it: 5-minute rules multiply by 300, and
# `auth-login-failure-rate` multiplies by 900 because it evaluates over 15m. A 5m gate on
# a 15m rule would demand three times the traffic density the rule itself asks for.
#
# The DENOMINATOR SERIES is per rule, not shared: each gate counts the population that
# rule's own arithmetic divides by — `http_server_requests_total` for the two HTTP rules,
# `job_runs_total` for the worker rule, `auth_login_total` for the login rule. Gating the
# worker rule on HTTP traffic would tie the worker's alerting to a signal it has nothing
# to do with, and would leave it dark on an api-idle environment that is still running
# jobs.
#
# `db-pool-contention` is deliberately NOT gated. It reads a gauge, not a percentile or a
# ratio, so one sample is a legitimate observation: a single queued connection is a real
# queued connection. Adding a traffic floor there would remove coverage for no benefit.
module "alerts" {
  count  = var.grafana_alerting_auth != "" ? 1 : 0
  source = "git::https://github.com/quynhonsemiconductor/qnsc-tf-modules.git//modules/observability-alerts?ref=observability-alerts-v1.1.1"

  product                    = var.product
  env                        = var.env
  prometheus_datasource_name = var.grafana_alerting.prometheus_datasource_name
  folder_uid                 = var.grafana_alerting.alerts_folder_uid

  rules = [
    {
      name        = "db-pool-contention"
      promql      = "db_pool_waiting{deployment_environment_name=\"${var.env}\"}"
      for         = "5m"
      op          = "gt"
      threshold   = local.alert_thresholds.db_pool_waiting
      severity    = "warning"
      summary     = "Connections are queueing for the DB pool in ${var.env} — pool is undersized or a query is holding connections too long."
      runbook_url = "${local.runbook_base_url}/db-pool-contention.md"
    },
    {
      name        = "http-5xx-rate"
      promql      = "(sum(rate(http_server_errors_total{deployment_environment_name=\"${var.env}\"}[5m])) or vector(0)) / sum(rate(http_server_requests_total{deployment_environment_name=\"${var.env}\"}[5m])) and on() (sum(rate(http_server_requests_total{deployment_environment_name=\"${var.env}\"}[5m])) * 300 >= ${local.alert_thresholds.min_samples_5m})"
      for         = "5m"
      op          = "gt"
      threshold   = local.alert_thresholds.http_error_rate
      severity    = "critical"
      summary     = "HTTP 5xx rate above ${local.alert_thresholds.http_error_rate * 100}% in ${var.env} for 5m, over at least ${local.alert_thresholds.min_samples_5m} requests."
      runbook_url = "${local.runbook_base_url}/http-5xx-rate.md"
    },
    {
      name        = "http-p99-latency"
      promql      = "histogram_quantile(0.99, sum(rate(http_server_duration_milliseconds_bucket{deployment_environment_name=\"${var.env}\"}[5m])) by (le)) and on() (sum(rate(http_server_requests_total{deployment_environment_name=\"${var.env}\"}[5m])) * 300 >= ${local.alert_thresholds.min_samples_5m})"
      for         = "5m"
      op          = "gt"
      threshold   = local.alert_thresholds.http_p99_latency_ms
      severity    = "warning"
      summary     = "HTTP p99 latency above ${local.alert_thresholds.http_p99_latency_ms}ms in ${var.env} for 5m, over at least ${local.alert_thresholds.min_samples_5m} requests — a reported value of exactly 10000 means the histogram saturated at its largest bucket, not that p99 was 10s."
      runbook_url = "${local.runbook_base_url}/http-p99-latency.md"
    },
    # ── The coverage that survives at low traffic ──────────────────────────────
    # Every gated rule above trades sensitivity for trustworthiness, and at opshub's
    # pre-launch traffic that trade costs nearly all of the sensitivity. This rule is what
    # buys it back, and it works precisely because it is a COUNT rather than a percentile:
    # "four requests took longer than a second in the last half hour" is exactly as true
    # over 4 requests as over 40,000, so no sample floor is needed or wanted, and none is
    # applied.
    #
    # It is also the rule that would have described rally's page HONESTLY. Where p99
    # reported `A=10000` — a clamped bucket boundary that an on-call reader has to know the
    # histogram's internals to interpret — this reports a plain integer count of requests
    # that crossed the line, which needs no interpretation at all.
    #
    # THE SHAPE: `le="+Inf"` is the total request count in the histogram, and the bucket at
    # the chosen boundary is the count of requests at or under it, because OTel histogram
    # buckets are CUMULATIVE. Subtracting gives the count strictly above the boundary. It
    # is written as two `sum(increase(...))` terms rather than one expression over a
    # negative matcher because a `le!=` selector would sum every intermediate cumulative
    # bucket and count the same request many times over.
    #
    # `increase()` rather than `rate()` so the result is a whole number of requests that
    # matches the threshold's units and the summary's wording — a reader comparing the
    # panel to the page should not have to multiply anything by 1800.
    #
    # 30m rather than 5m: at this traffic level a 5-minute window is thin enough that the
    # count itself becomes noisy, and a slow-request problem worth waking someone for
    # persists for half an hour. Both terms MUST use the same window or the subtraction
    # compares different spans of traffic.
    {
      name        = "http-slow-request-count"
      promql      = "sum(increase(http_server_duration_milliseconds_bucket{le=\"+Inf\", deployment_environment_name=\"${var.env}\"}[30m])) - sum(increase(http_server_duration_milliseconds_bucket{le=\"${local.alert_thresholds.slow_request_bucket_ms}\", deployment_environment_name=\"${var.env}\"}[30m]))"
      for         = "5m"
      op          = "gt"
      threshold   = local.alert_thresholds.slow_request_count_30m
      severity    = "warning"
      summary     = "More than ${local.alert_thresholds.slow_request_count_30m} requests took longer than ${local.alert_thresholds.slow_request_bucket_ms}ms in ${var.env} over 30m — a count, not a percentile, so this is meaningful at any traffic level and is not volume-gated."
      runbook_url = "${local.runbook_base_url}/http-slow-request-count.md"
    },
    {
      name        = "worker-job-failure-rate"
      promql      = "(sum(rate(job_failures_total{deployment_environment_name=\"${var.env}\"}[5m])) or vector(0)) / sum(rate(job_runs_total{deployment_environment_name=\"${var.env}\"}[5m])) and on() (sum(rate(job_runs_total{deployment_environment_name=\"${var.env}\"}[5m])) * 300 >= ${local.alert_thresholds.min_samples_5m})"
      for         = "5m"
      op          = "gt"
      threshold   = local.alert_thresholds.worker_failure_rate
      severity    = "warning"
      summary     = "Worker job failure rate above ${local.alert_thresholds.worker_failure_rate * 100}% in ${var.env} for 5m, over at least ${local.alert_thresholds.min_samples_5m} job runs."
      runbook_url = "${local.runbook_base_url}/worker-job-failure-rate.md"
    },
    {
      name        = "auth-login-failure-rate"
      promql      = "(sum(rate(auth_login_total{deployment_environment_name=\"${var.env}\", outcome=\"failure\"}[15m])) or vector(0)) / sum(rate(auth_login_total{deployment_environment_name=\"${var.env}\"}[15m])) and on() (sum(rate(auth_login_total{deployment_environment_name=\"${var.env}\"}[15m])) * 900 >= ${local.alert_thresholds.min_login_attempts_15m})"
      for         = "15m"
      op          = "gt"
      threshold   = local.alert_thresholds.auth_login_failure_rate
      severity    = "warning"
      summary     = "Login failure rate above ${local.alert_thresholds.auth_login_failure_rate * 100}% in ${var.env} for 15m, over at least ${local.alert_thresholds.min_login_attempts_15m} attempts — entra-login/dev-login both collapse their failure detail before it reaches the caller, check Recent errors / Logs Explorer for the actual cause."
      runbook_url = "${local.runbook_base_url}/auth-login-failure-rate.md"
    },
  ]
}

resource "grafana_slo" "http_availability" {
  count       = var.grafana_alerting_auth != "" ? 1 : 0
  provider    = grafana
  name        = "HTTP availability (${var.env})"
  description = "Fraction of HTTP requests that do not return a 5xx, over a rolling 30-day window."
  folder_uid  = var.grafana_alerting.slos_folder_uid

  query {
    type = "ratio"
    ratio {
      success_metric = "http_server_requests_total{deployment_environment_name=\"${var.env}\", status_class!=\"5xx\"}"
      total_metric   = "http_server_requests_total{deployment_environment_name=\"${var.env}\"}"
    }
  }

  objectives {
    value  = local.slo_success_objective
    window = "30d"
  }

  destination_datasource {
    uid = data.grafana_data_source.prometheus[0].uid
  }

  label {
    key   = "product"
    value = var.product
  }
  label {
    key   = "env"
    value = var.env
  }

  alerting {
    fastburn {
      annotation {
        key   = "name"
        value = "SLO fast burn: HTTP availability (${var.env})"
      }
      annotation {
        key   = "description"
        value = "Error budget for HTTP availability in ${var.env} is burning fast enough to exhaust the 30-day budget in hours, not days."
      }
    }
    slowburn {
      annotation {
        key   = "name"
        value = "SLO slow burn: HTTP availability (${var.env})"
      }
      annotation {
        key   = "description"
        value = "Error budget for HTTP availability in ${var.env} is burning steadily — on pace to exhaust the 30-day budget before the window resets."
      }
    }
  }
}

data "grafana_data_source" "prometheus" {
  count    = var.grafana_alerting_auth != "" ? 1 : 0
  provider = grafana
  name     = var.grafana_alerting.prometheus_datasource_name
}

data "grafana_data_source" "loki" {
  count    = var.grafana_alerting_auth != "" ? 1 : 0
  provider = grafana
  name     = var.grafana_alerting.logs_datasource_name
}

data "grafana_data_source" "tempo" {
  count    = var.grafana_alerting_auth != "" ? 1 : 0
  provider = grafana
  name     = var.grafana_alerting.traces_datasource_name
}

# TWO dashboards, not one growing page — same RED/USE split as rally: "is something
# wrong" (Overview) is a different question from "why" (Runtime & Dependencies).
resource "grafana_dashboard" "overview" {
  count     = var.grafana_alerting_auth != "" ? 1 : 0
  provider  = grafana
  folder    = var.grafana_alerting.product_dashboards_folder_uid
  overwrite = true

  config_json = jsonencode({
    title         = "Overview (${var.env})"
    uid           = "opshub-overview-${var.env}"
    timezone      = "browser"
    editable      = false
    schemaVersion = 39
    time          = { from = "now-6h", to = "now" }
    refresh       = "1m"
    tags          = ["opshub", var.env, "provisioned"]

    templating = {
      list = [
        {
          name    = "level"
          type    = "custom"
          label   = "Level"
          query   = "All : .*,error : error,warn : warn,info : info,debug : debug"
          current = { text = "All", value = ".*" }
          options = [
            { text = "All", value = ".*", selected = true },
            { text = "error", value = "error", selected = false },
            { text = "warn", value = "warn", selected = false },
            { text = "info", value = "info", selected = false },
            { text = "debug", value = "debug", selected = false },
          ]
        }
      ]
    }

    links = [
      {
        title       = "Search traces (Tempo Explore)"
        url         = "/explore?left=%7B%22datasource%22:%22${data.grafana_data_source.tempo[0].uid}%22,%22queries%22:%5B%7B%22refId%22:%22A%22,%22queryType%22:%22traceqlSearch%22%7D%5D,%22range%22:%7B%22from%22:%22now-1h%22,%22to%22:%22now%22%7D%7D"
        type        = "link"
        icon        = "search"
        targetBlank = true
      }
    ]

    annotations = {
      list = [
        {
          name       = "Deploys"
          datasource = { type = "grafana", uid = "-- Grafana --" }
          enable     = true
          iconColor  = "blue"
          tags       = ["deploy", "opshub", var.env]
          type       = "tags"
        }
      ]
    }

    panels = [
      {
        id         = 1
        title      = "HTTP request rate, by route"
        type       = "timeseries"
        gridPos    = { h = 8, w = 12, x = 0, y = 0 }
        datasource = { type = "prometheus", uid = data.grafana_data_source.prometheus[0].uid }
        targets = [{
          expr         = "sum(rate(http_server_requests_total{deployment_environment_name=\"${var.env}\"}[5m])) by (route)"
          legendFormat = "{{route}}"
          refId        = "A"
        }]
      },
      {
        id         = 2
        title      = "HTTP error rate"
        type       = "timeseries"
        gridPos    = { h = 8, w = 12, x = 12, y = 0 }
        datasource = { type = "prometheus", uid = data.grafana_data_source.prometheus[0].uid }
        fieldConfig = {
          defaults = {
            unit   = "percentunit"
            custom = { thresholdsStyle = { mode = "line" } }
            thresholds = {
              steps = [
                { color = "green", value = null },
                { color = "yellow", value = local.alert_thresholds.http_error_rate / 2 },
                { color = "red", value = local.alert_thresholds.http_error_rate },
              ]
            }
          }
        }
        targets = [{
          expr         = "(sum(rate(http_server_errors_total{deployment_environment_name=\"${var.env}\"}[5m])) or vector(0)) / sum(rate(http_server_requests_total{deployment_environment_name=\"${var.env}\"}[5m]))"
          legendFormat = "error rate"
          refId        = "A"
        }]
      },
      {
        id         = 3
        title      = "HTTP status code distribution"
        type       = "timeseries"
        gridPos    = { h = 8, w = 12, x = 0, y = 8 }
        datasource = { type = "prometheus", uid = data.grafana_data_source.prometheus[0].uid }
        targets = [{
          expr         = "sum(rate(http_server_requests_total{deployment_environment_name=\"${var.env}\"}[5m])) by (status_class)"
          legendFormat = "{{status_class}}"
          refId        = "A"
        }]
      },
      {
        id         = 4
        title      = "HTTP p50/p95/p99 latency"
        type       = "timeseries"
        gridPos    = { h = 8, w = 12, x = 12, y = 8 }
        datasource = { type = "prometheus", uid = data.grafana_data_source.prometheus[0].uid }
        fieldConfig = {
          defaults = {
            unit   = "ms"
            custom = { thresholdsStyle = { mode = "line" } }
            thresholds = {
              steps = [
                { color = "green", value = null },
                { color = "red", value = local.alert_thresholds.http_p99_latency_ms },
              ]
            }
          }
        }
        targets = [
          {
            expr         = "histogram_quantile(0.50, sum(rate(http_server_duration_milliseconds_bucket{deployment_environment_name=\"${var.env}\"}[5m])) by (le))"
            legendFormat = "p50"
            refId        = "A"
          },
          {
            expr         = "histogram_quantile(0.95, sum(rate(http_server_duration_milliseconds_bucket{deployment_environment_name=\"${var.env}\"}[5m])) by (le))"
            legendFormat = "p95"
            refId        = "B"
          },
          {
            expr         = "histogram_quantile(0.99, sum(rate(http_server_duration_milliseconds_bucket{deployment_environment_name=\"${var.env}\"}[5m])) by (le))"
            legendFormat = "p99"
            refId        = "C"
          },
        ]
      },
      # "Is login itself working" — moved ABOVE DB pool/worker rate, same reordering
      # rally applied: this and the HTTP error rate above are the two golden-signal
      # panels most worth seeing without scrolling.
      {
        id         = 5
        title      = "Login success vs failure rate"
        type       = "timeseries"
        gridPos    = { h = 8, w = 12, x = 0, y = 16 }
        datasource = { type = "prometheus", uid = data.grafana_data_source.prometheus[0].uid }
        fieldConfig = {
          defaults = {
            unit   = "percentunit"
            custom = { thresholdsStyle = { mode = "line" } }
            thresholds = {
              steps = [
                { color = "green", value = null },
                { color = "red", value = local.alert_thresholds.auth_login_failure_rate },
              ]
            }
          }
        }
        targets = [{
          expr         = "(sum(rate(auth_login_total{deployment_environment_name=\"${var.env}\", outcome=\"failure\"}[15m])) or vector(0)) / sum(rate(auth_login_total{deployment_environment_name=\"${var.env}\"}[15m]))"
          legendFormat = "failure rate"
          refId        = "A"
        }]
      },
      # DARK until DbPoolMetrics is wired app-side — see this block's own header
      # comment. Kept for structural/layout parity with rally.
      {
        id         = 6
        title      = "DB pool: in use vs waiting"
        type       = "timeseries"
        gridPos    = { h = 8, w = 12, x = 0, y = 24 }
        datasource = { type = "prometheus", uid = data.grafana_data_source.prometheus[0].uid }
        fieldConfig = {
          defaults = {
            custom = { thresholdsStyle = { mode = "line" } }
            thresholds = {
              steps = [
                { color = "green", value = null },
                { color = "red", value = local.alert_thresholds.db_pool_waiting },
              ]
            }
          }
        }
        targets = [
          {
            expr         = "sum(db_pool_in_use{deployment_environment_name=\"${var.env}\"}) by (service_name)"
            legendFormat = "{{service_name}} in_use"
            refId        = "A"
          },
          {
            expr         = "sum(db_pool_waiting{deployment_environment_name=\"${var.env}\"}) by (service_name)"
            legendFormat = "{{service_name}} waiting"
            refId        = "B"
          },
        ]
      },
      {
        id         = 7
        title      = "Worker job success vs failure rate"
        type       = "timeseries"
        gridPos    = { h = 8, w = 12, x = 12, y = 24 }
        datasource = { type = "prometheus", uid = data.grafana_data_source.prometheus[0].uid }
        targets = [
          {
            expr         = "sum(rate(job_runs_total{deployment_environment_name=\"${var.env}\"}[5m]))"
            legendFormat = "runs"
            refId        = "A"
          },
          {
            expr         = "sum(rate(job_failures_total{deployment_environment_name=\"${var.env}\"}[5m]))"
            legendFormat = "failures"
            refId        = "B"
          },
        ]
      },
      {
        id         = 8
        title      = "Recent errors"
        type       = "logs"
        gridPos    = { h = 8, w = 24, x = 0, y = 32 }
        datasource = { type = "loki", uid = data.grafana_data_source.loki[0].uid }
        options = {
          dedupStrategy      = "none"
          enableLogDetails   = true
          prettifyLogMessage = false
          showCommonLabels   = false
          showLabels         = false
          showTime           = true
          sortOrder          = "Descending"
          wrapLogMessage     = false
        }
        targets = [{
          datasource = { type = "loki", uid = data.grafana_data_source.loki[0].uid }
          expr       = "{service_name=~\"${var.product}-api|${var.product}-worker\", deployment_environment_name=\"${var.env}\"} | detected_level=\"error\""
          refId      = "A"
        }]
      },
      {
        id         = 9
        title      = "Logs Explorer"
        type       = "logs"
        gridPos    = { h = 10, w = 24, x = 0, y = 42 }
        datasource = { type = "loki", uid = data.grafana_data_source.loki[0].uid }
        options = {
          dedupStrategy      = "none"
          enableLogDetails   = true
          prettifyLogMessage = false
          showCommonLabels   = false
          showLabels         = true
          showTime           = true
          sortOrder          = "Descending"
          wrapLogMessage     = false
        }
        targets = [{
          datasource = { type = "loki", uid = data.grafana_data_source.loki[0].uid }
          expr       = "{service_name=~\"${var.product}-api|${var.product}-worker\", deployment_environment_name=\"${var.env}\"} | detected_level=~\"$level\""
          refId      = "A"
        }]
      },
    ]
  })
}

resource "grafana_dashboard" "runtime" {
  count     = var.grafana_alerting_auth != "" ? 1 : 0
  provider  = grafana
  folder    = var.grafana_alerting.product_dashboards_folder_uid
  overwrite = true

  config_json = jsonencode({
    title         = "Runtime & Dependencies (${var.env})"
    uid           = "opshub-runtime-${var.env}"
    timezone      = "browser"
    editable      = false
    schemaVersion = 39
    time          = { from = "now-6h", to = "now" }
    refresh       = "1m"
    tags          = ["opshub", var.env, "provisioned"]

    annotations = {
      list = [
        {
          name       = "Deploys"
          datasource = { type = "grafana", uid = "-- Grafana --" }
          enable     = true
          iconColor  = "blue"
          tags       = ["deploy", "opshub", var.env]
          type       = "tags"
        }
      ]
    }

    panels = [
      {
        id          = 1
        title       = "DB client operation latency (p99, by operation)"
        type        = "timeseries"
        gridPos     = { h = 8, w = 12, x = 0, y = 0 }
        datasource  = { type = "prometheus", uid = data.grafana_data_source.prometheus[0].uid }
        fieldConfig = { defaults = { unit = "s" } }
        targets = [{
          expr         = "histogram_quantile(0.99, sum(rate(db_client_operation_duration_seconds_bucket{deployment_environment_name=\"${var.env}\"}[5m])) by (le, db_operation_name))"
          legendFormat = "{{db_operation_name}}"
          refId        = "A"
        }]
      },
      {
        id         = 2
        title      = "DB client connections: by state, vs pending requests"
        type       = "timeseries"
        gridPos    = { h = 8, w = 12, x = 12, y = 0 }
        datasource = { type = "prometheus", uid = data.grafana_data_source.prometheus[0].uid }
        targets = [
          {
            expr         = "sum(db_client_connection_count{deployment_environment_name=\"${var.env}\"}) by (service_name, db_client_connection_state)"
            legendFormat = "{{service_name}} {{db_client_connection_state}}"
            refId        = "A"
          },
          {
            expr         = "sum(db_client_connection_pending_requests{deployment_environment_name=\"${var.env}\"}) by (service_name)"
            legendFormat = "{{service_name}} pending"
            refId        = "B"
          },
        ]
      },
      {
        id         = 3
        title      = "Outbound HTTP client calls: rate + p99 latency"
        type       = "timeseries"
        gridPos    = { h = 8, w = 12, x = 0, y = 8 }
        datasource = { type = "prometheus", uid = data.grafana_data_source.prometheus[0].uid }
        targets = [{
          expr         = "sum(rate(http_client_duration_milliseconds_count{deployment_environment_name=\"${var.env}\"}[5m])) by (net_peer_name)"
          legendFormat = "{{net_peer_name}}"
          refId        = "A"
        }]
      },
      {
        id         = 4
        title      = "Queue processed rate + lag (p99)"
        type       = "timeseries"
        gridPos    = { h = 8, w = 12, x = 12, y = 8 }
        datasource = { type = "prometheus", uid = data.grafana_data_source.prometheus[0].uid }
        targets = [
          {
            expr         = "sum(rate(queue_processed_total{deployment_environment_name=\"${var.env}\"}[5m]))"
            legendFormat = "processed/s"
            refId        = "A"
          },
          {
            expr         = "histogram_quantile(0.99, sum(rate(queue_lag_seconds_bucket{deployment_environment_name=\"${var.env}\"}[5m])) by (le))"
            legendFormat = "lag p99 (s)"
            refId        = "B"
          },
        ]
      },
      {
        id          = 5
        title       = "Node.js event loop lag (p99, by service)"
        type        = "timeseries"
        gridPos     = { h = 8, w = 12, x = 0, y = 16 }
        datasource  = { type = "prometheus", uid = data.grafana_data_source.prometheus[0].uid }
        fieldConfig = { defaults = { unit = "s" } }
        targets = [{
          expr         = "nodejs_eventloop_delay_p99_seconds{deployment_environment_name=\"${var.env}\"}"
          legendFormat = "{{service_name}}"
          refId        = "A"
        }]
      },
      {
        id          = 6
        title       = "V8 heap used, by service"
        type        = "timeseries"
        gridPos     = { h = 8, w = 12, x = 12, y = 16 }
        datasource  = { type = "prometheus", uid = data.grafana_data_source.prometheus[0].uid }
        fieldConfig = { defaults = { unit = "bytes" } }
        targets = [{
          expr         = "sum(v8js_memory_heap_used_bytes{deployment_environment_name=\"${var.env}\"}) by (service_name)"
          legendFormat = "{{service_name}}"
          refId        = "A"
        }]
      },
      {
        id         = 7
        title      = "Log volume (lines/5m)"
        type       = "timeseries"
        gridPos    = { h = 8, w = 24, x = 0, y = 24 }
        datasource = { type = "loki", uid = data.grafana_data_source.loki[0].uid }
        targets = [{
          datasource   = { type = "loki", uid = data.grafana_data_source.loki[0].uid }
          expr         = "sum(count_over_time({service_name=~\"${var.product}-api|${var.product}-worker\", deployment_environment_name=\"${var.env}\"}[5m])) by (service_name)"
          legendFormat = "{{service_name}}"
          refId        = "A"
        }]
      },
    ]
  })
}
