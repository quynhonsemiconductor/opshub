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
    { name = "SES_CONFIGURATION_SET", value = var.ses_configuration_set },
  ]
}

# ── Secrets (scaffolding only — values are set out of band) ───────────────────
# Terraform creates the CONTAINERS and never their contents: a value in state is a
# value in the state file. Each is created empty, which is also the "unpopulated"
# signal — a task injected with an empty secret fails to boot, so a forgotten secret
# is a failed deploy rather than an app running on a blank credential.
module "secrets" {
  source      = "git::https://github.com/QNSC-VN/qnsc-tf-modules.git//modules/secrets?ref=secrets-v2.1.1"
  prefix      = "${var.product}/${var.env}"
  kms_key_arn = local.kms_key_arn

  recovery_window_days = var.secrets_recovery_window_days

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
    # Cloudflare Tunnel connector token (cloudflared TUNNEL_TOKEN). Created out of band
    # with the tunnel itself — Terraform cannot mint a token without owning the tunnel's
    # lifecycle, and destroying a tunnel to recreate it invalidates every deployed
    # connector. Present unconditionally so `secret_arns["tunnel-token"]` resolves; the
    # sidecar is what is gated, not the container.
    "tunnel-token"        = "Cloudflare Tunnel connector token (cloudflared TUNNEL_TOKEN)"
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
  source = "git::https://github.com/QNSC-VN/qnsc-tf-modules.git//modules/rds?ref=rds-v2.1.2"

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
  source = "git::https://github.com/QNSC-VN/qnsc-tf-modules.git//modules/cache?ref=cache-v1.1.0"

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
  source = "git::https://github.com/QNSC-VN/qnsc-tf-modules.git//modules/app-bucket?ref=app-bucket-v1.0.1"

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
  source = "git::https://github.com/QNSC-VN/qnsc-tf-modules.git//modules/ecs-cluster?ref=ecs-cluster-v2.0.0"
  name   = local.name
  tags   = local.tags

  # Always stated, never inherited: the module default is "enhanced", whose per-task
  # metrics are billed as custom CloudWatch metrics. See the variable.
  container_insights = var.container_insights
}

# ── ECS service — API ─────────────────────────────────────────────────────────
module "api" {
  source = "git::https://github.com/QNSC-VN/qnsc-tf-modules.git//modules/ecs-service?ref=ecs-service-v2.3.1"

  use_firelens = module.firelens_agent_api.enabled

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
  )

  # Includes the AWS-managed RDS secret: the execution role needs GetSecretValue on it
  # to inject DATABASE_USER/PASSWORD. Omit it and the task cannot start at all ("unable
  # to pull secrets") — a boot failure, not a runtime error. The migrator reuses the
  # api's roles, so it is covered by the api's copy of this list too.
  secret_arns = concat(values(module.secrets.secret_arns), [module.rds.master_secret_arn])
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
  source = "git::https://github.com/QNSC-VN/qnsc-tf-modules.git//modules/ecs-service?ref=ecs-service-v2.3.1"

  use_firelens = module.firelens_agent_worker.enabled

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
  additional_containers = module.otel_agent_worker.container_definitions

  # Includes the AWS-managed RDS secret: the execution role needs GetSecretValue on it
  # to inject DATABASE_USER/PASSWORD. Omit it and the task cannot start at all ("unable
  # to pull secrets") — a boot failure, not a runtime error. The migrator reuses the
  # api's roles, so it is covered by the api's copy of this list too.
  secret_arns = concat(values(module.secrets.secret_arns), [module.rds.master_secret_arn])
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
  source = "git::https://github.com/QNSC-VN/qnsc-tf-modules.git//modules/oneshot-task?ref=oneshot-task-v2.0.0"

  name               = "${local.name}-migrator"
  container_name     = "migrator"
  image              = "${local.ecr_base}/${var.product}-migrator:${var.image_tag}"
  cpu                = 512
  memory             = 1024
  execution_role_arn = module.api.execution_role_arn
  task_role_arn      = module.api.task_role_arn
  region             = var.region
  log_retention_days = var.log_retention_days

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
module "tunnel_api" {
  source = "git::https://github.com/QNSC-VN/qnsc-tf-modules.git//modules/tunnel-agent?ref=tunnel-agent-v1.0.0"

  tunnel_token_secret_arn = var.tunnel_enabled ? module.secrets.secret_arns["tunnel-token"] : ""
  app_port                = 3000
  log_group               = "/ecs/${local.name}-api"
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
  source = "git::https://github.com/QNSC-VN/qnsc-tf-modules.git//modules/observability-agent?ref=observability-agent-v1.0.0"

  product       = var.product
  env           = var.env
  otlp_endpoint = var.observability.otlp_endpoint
  # try(): the secret is not created while the OTel path is dormant, and the module is a no-op
  # in that state anyway — so an absent ARN is the correct input here, not an error.
  token_secret_arn = try(module.secrets.secret_arns["observability-token"], "")
  log_group        = "/ecs/${local.name}-api"
  region           = var.region
}

module "otel_agent_worker" {
  source = "git::https://github.com/QNSC-VN/qnsc-tf-modules.git//modules/observability-agent?ref=observability-agent-v1.0.0"

  product          = var.product
  env              = var.env
  otlp_endpoint    = var.observability.otlp_endpoint
  token_secret_arn = try(module.secrets.secret_arns["observability-token"], "")
  log_group        = "/ecs/${local.name}-worker"
  region           = var.region
}

# Ships each service's router (task-level, non-app) logs to Loki, same shared stack the
# OTel sidecars push metrics/traces to. Adopted from rally — opshub previously had no log
# shipping at all, so an incident meant reading CloudWatch Logs Insights by hand instead
# of Grafana Explore alongside the metrics and traces for the same request.
module "firelens_agent_api" {
  source = "git::https://github.com/QNSC-VN/qnsc-tf-modules.git//modules/firelens-agent?ref=firelens-agent-v0.2.1"

  service_name     = "${var.product}-api"
  product          = var.product
  env              = var.env
  otlp_endpoint    = var.observability.otlp_endpoint
  token_secret_arn = try(module.secrets.secret_arns["observability-token"], "")
  router_log_group = "/ecs/${local.name}-api"
  region           = var.region
  kms_key_arn      = local.kms_key_arn
}

module "firelens_agent_worker" {
  source = "git::https://github.com/QNSC-VN/qnsc-tf-modules.git//modules/firelens-agent?ref=firelens-agent-v0.2.1"

  service_name     = "${var.product}-worker"
  product          = var.product
  env              = var.env
  otlp_endpoint    = var.observability.otlp_endpoint
  token_secret_arn = try(module.secrets.secret_arns["observability-token"], "")
  router_log_group = "/ecs/${local.name}-worker"
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
  source = "git::https://github.com/QNSC-VN/qnsc-tf-modules.git//modules/pages-web?ref=pages-web-v1.0.1"

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
  source = "git::https://github.com/QNSC-VN/qnsc-tf-modules.git//modules/dns-record?ref=dns-record-v1.1.0"

  enabled = local.cloudflare_zone_id != ""
  zone_id = local.cloudflare_zone_id
  name    = var.api_record
  type    = "CNAME"
  # Tunnel or ALB, and the CNAME target is the whole difference:
  #   tunnel — <tunnel-id>.cfargotunnel.com, a Cloudflare-internal name that resolves
  #            only through the edge. It CANNOT be grey-clouded: an orange-cloud record
  #            is the only way traffic reaches a connector.
  #   ALB    — the load balancer's public DNS name (null today; see module.tunnel_api).
  content = var.tunnel_enabled ? "${var.tunnel_id}.cfargotunnel.com" : try(data.terraform_remote_state.runtime.outputs.alb_dns_name, "")
  proxied = true
  comment = "${local.name} API → ALB via Cloudflare proxy (managed by ${var.product}-infra ${var.env})"
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
# its own change"; rally then did exactly that in QNSC-VN/rally#392, so this closes the gap
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
module "observability" {
  source = "git::https://github.com/QNSC-VN/qnsc-tf-modules.git//modules/observability?ref=observability-v4.2.0"

  create_dashboard = var.create_dashboard

  name              = local.name
  region            = var.region
  ecs_cluster_name  = module.ecs_cluster.cluster_name
  ecs_service_names = [module.api.service_name, module.worker.service_name]

  # Node mode only (var.cache.mode default), null for serverless — same guard
  # rally's stack uses. opshub's cache is always its own dedicated node/instance
  # per environment (no shared-node concept here), so this is always safe to
  # wire when the cache is enabled at all.
  cache_cluster_id = var.cache.enabled && var.cache.mode == "node" ? module.cache[0].cluster_id : ""

  # Empty while the api is tunnelled: the shared ALBs were deleted when both products moved to
  # tunnels, so `runtime.outputs.alb_arn` is absent and the two ALB alarms have nothing to read.
  alb_arn = var.tunnel_enabled ? "" : try(data.terraform_remote_state.runtime.outputs.alb_arn, "")

  # `identifier` (opshub-dev), NOT `instance_id` (db-XXXX…). CloudWatch publishes RDS metrics
  # under the DBInstanceIdentifier dimension, and passing the resource id leaves the RDS alarms
  # in INSUFFICIENT_DATA permanently while appearing covered — a trap rally fell into for six
  # alarms across both environments. observability-v3.0.0+ rejects a resource id outright, so
  # this fails the plan rather than regressing silently.
  rds_instance_id = module.rds.identifier

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
