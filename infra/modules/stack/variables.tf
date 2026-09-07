// The product stack's input surface.
//
// Everything an environment CHOOSES is here; everything DERIVED from those choices
// lives in main.tf's locals. That split is the point of the module: develop and prod
// can no longer differ in structure, only in the values below, so a change made for
// one environment is automatically made for both.
//
// Defaults lean SAFE rather than cheap — a forgotten input should err toward
// production behaviour (no Spot, longer retention, no force_destroy), because the
// failure mode of a too-cheap production is worse than a too-careful develop.

// ── Identity ────────────────────────────────────────────────────────────────────

variable "product" {
  description = "Product slug. Drives resource names, ECR repos and secret prefixes."
  type        = string
}

variable "env" {
  description = "Environment name as it appears in tags and secret prefixes (e.g. develop, production)."
  type        = string
}

variable "env_slug" {
  description = <<-EOT
    Short environment token used in RESOURCE NAMES (`<product>-<env_slug>`).
    Deliberately separate from `env`: production resources are named `opshub-prod`
    while the environment is called `production`, and renaming them would force
    replacement of the cluster, the RDS instance and every log group.
  EOT
  type        = string
}

variable "region" {
  type = string
}

// ── Networking / DNS ────────────────────────────────────────────────────────────

variable "app_domain" {
  description = "Public SPA hostname. Also drives CORS_ORIGINS and APP_URL."
  type        = string
}

variable "api_domain" {
  description = "Public API hostname, used for the ALB host-header rule and the API's Cloudflare record."
  type        = string
}

variable "web_record" {
  description = "Cloudflare CNAME label for the SPA (e.g. `opshub-dev`, `opshub`)."
  type        = string
}

variable "api_record" {
  description = "Cloudflare CNAME label for the API (e.g. `opshub-api-dev`, `opshub-api`)."
  type        = string
}

// ── Remote state ────────────────────────────────────────────────────────────────

variable "shared_state_key" {
  description = "State key of the product's _shared stack (ECR, KMS, Cloudflare zone)."
  type        = string
}

variable "runtime_state_key" {
  description = "State key of the platform runtime stack for this environment (VPC, ALB, SGs)."
  type        = string
}

// ── Application ─────────────────────────────────────────────────────────────────

variable "image_tag" {
  description = "Container image tag for api/worker/migrator. `latest` is acceptable in develop; production pins the release tag that triggered the apply."
  type        = string
  default     = "latest"
}

variable "entra_tenant_id" {
  description = "Microsoft Entra tenant id (public identifier)."
  type        = string
}

variable "entra_client_id" {
  description = <<-EOT
    Entra application (client) id for THIS environment — a distinct app registration
    per environment, because the redirect URIs differ.

    Empty leaves SSO dormant: `ENTRA_CLIENT_ID` is optional in the API's env schema,
    so the task still boots and the Entra-dependent features self-disable rather than
    crash-looping. That is the state production is in until its app registration
    exists.
  EOT
  type        = string
}

variable "entra_client_secret_set" {
  description = <<-EOT
    Inject `entra-client-secret` into api and worker, enabling the BFF's server-side
    code exchange.

    OFF by default for the same mechanical reason as `graph_client_secret_set`: ECS
    cannot inject a Secrets Manager secret that holds no value — the task dies before the
    app runs — so wiring a credential that has not been minted yet takes the whole
    environment down.

    This one cannot be generated on this side. It is a confidential-client secret created
    on the Entra app registration, so the order is: create the secret in Entra, put it in
    Secrets Manager, then flip this.

    While it is false the SPA can still reach `POST /v1/bff/login` and receive an
    authorize URL; the callback is what fails, closed, with a generic 401. Everything
    that does not depend on interactive login is unaffected.
  EOT
  type        = bool
  default     = false
}

variable "graph_client_secret_set" {
  description = <<-EOT
    Inject `graph-client-secret` into api and worker.

    OFF by default, and the default is the point. ECS cannot inject a Secrets Manager
    secret that holds no value — the task dies before the app runs with
    "ResourceInitializationError ... can't find the specified secret value for staging
    label: AWSCURRENT". So wiring an OPTIONAL integration unconditionally makes it
    mandatory in the worst possible way: this single empty secret is why no opshub task
    has ever started, even though the app treats the Graph features as self-disabling.

    While this is false the Graph-backed surfaces (compliance sync, security posture,
    workforce provisioning, PIM) report themselves disabled and everything else runs.
    Populate the secret in Secrets Manager first, then flip this — the same two-step
    shape rally uses for credentials it cannot generate.
  EOT
  type        = bool
  default     = false
}

variable "db_role_passwords_set" {
  description = <<-EOT
    Inject `db-app-password` / `db-worker-password` into the MIGRATOR, so the one-off
    cutover task can run `ALTER ROLE ... LOGIN PASSWORD ...` against them.

    A SEPARATE flag from `db_least_privilege`, and it has to be. The two steps are strictly
    ordered — the roles need a password before anything can authenticate as them — and each
    flag drives a different workload:

      db_role_passwords_set = true   → migrator can read the passwords, so the cutover
                                       task can set them on the roles
      db_least_privilege    = true   → api and worker authenticate as those roles

    Folding them into one flag makes the cutover impossible: a single apply would both hand
    the migrator the passwords and point the runtime at roles that are still NOLOGIN, so api
    and worker would fail with 28P01 before the cutover task could run. Hence two flags,
    flipped in two applies.

    OFF by default for the same reason `graph_client_secret_set` is: ECS cannot inject a
    Secrets Manager secret that holds no value, so turning this on before populating the
    secrets stops the migrator from starting at all.

    Runbook: docs/runbooks/db-role-least-privilege.md
  EOT
  type        = bool
  default     = false

  validation {
    # The one ordering mistake Terraform can actually observe. `db_least_privilege` without
    # this flag means the cutover task never had the passwords to apply, so the roles are
    # still NOLOGIN and both runtime tasks would fail authentication.
    condition     = var.db_role_passwords_set || !var.db_least_privilege
    error_message = "db_least_privilege requires db_role_passwords_set = true first: the roles need a password before api/worker can authenticate as them. Populate the secrets, set db_role_passwords_set, apply, run the cutover task, then set db_least_privilege."
  }
}

variable "db_least_privilege" {
  description = <<-EOT
    Point the api and worker tasks at the least-privilege Postgres roles (`opshub_app` /
    `opshub_worker`) instead of the RDS master credential.

    OFF by default so merging this changes nothing that is running. Today all three tasks
    connect as the master user, which OWNS every table: an ordinary HTTP request carries
    rights to DROP the schema it is reading, and any row-level policy would be skipped,
    because Postgres exempts a table's owner from RLS unless FORCE ROW LEVEL SECURITY is
    also set. Moving the runtime off the owner is what makes an RLS layer possible at all.

    This is the LAST of three steps, and the order is not fully enforceable in Terraform.
    Before flipping it, in this environment:
      1. `pnpm db:migrate` has run, so migration 0012 has created the roles;
      2. the `db-app-password` / `db-worker-password` secrets hold a value and
         `db_role_passwords_set` is true;
      3. the cutover task has run, applying those values with
         `ALTER ROLE ... LOGIN PASSWORD ...` — see `db_role_passwords_set`.
    Flip it first and the tasks boot, fail to authenticate (28P01) and roll back. Step 2 is
    enforced by the validation on `db_role_passwords_set`; step 3 cannot be, because
    Terraform has no way to observe `pg_roles`.

    The MIGRATOR is deliberately unaffected — it needs DDL, and narrowing it means
    transferring schema ownership, a separate and more disruptive step.

    Full sequence, verification and rollback: docs/runbooks/db-role-least-privilege.md
  EOT
  type        = bool
  default     = false
}

variable "tunnel_enabled" {
  description = <<-EOT
    Serve this environment's api through a Cloudflare Tunnel sidecar instead of the
    shared ALB.

    Not an optimisation any more — a requirement. The shared ALBs in
    qnsc-infra/live/runtime-{dev,prod} were deleted once both products moved to tunnels,
    so `runtime.outputs.https_listener_arn` is null and `attach_alb = true` has nothing
    to attach to. Bringing an ALB back is `enable_alb = true` in that layer, at $18.40/mo
    plus $3.65 per enabled AZ.

    The saving is real but secondary: every request already arrives through Cloudflare
    (the SPA is a Pages project whose Function proxies /v1/* to the API), so the load
    balancer was a second TLS termination inside an already-proxied path.

    Turning this ON turns OFF the ALB target-group attachment, because a tunnelled task
    must not also be an ALB target — the target group would health-check a port the
    connector owns, and traffic could arrive by two paths with different TLS termination.

    The tunnel itself, its connector token and the routing rule are all created and
    owned BY TERRAFORM (`module.tunnel`, the shared `cf-tunnel` module) — unlike rally,
    which had to ADOPT two tunnels already created by hand in the dashboard, opshub has
    never had one, so there is nothing to preserve and no adopt-then-manage two-step
    needed. Turning this on with `cloudflare_account_id` set is enough on its own.

    WHAT IS GIVEN UP: ALB access logs, the option of an origin-side AWS WAF, and
    per-target-group CloudWatch alarms. Cloudflare's own analytics and a synthetic probe
    have to replace them before production relies on this.
  EOT
  type        = bool
  default     = false
}

variable "idle_schedule" {
  description = <<-EOT
    Cron/rate expression for an EventBridge Scheduler that IDLES this environment: stops
    the RDS instance AND scales both services to zero. Null (the default) creates no
    schedule, no role and no policy.

    Both halves matter. Stopping only the database leaves Fargate tasks running against
    an instance they cannot reach — still billed, unable to serve, and invisible, because
    `/v1/healthz` answers 200 regardless of whether Postgres is reachable.

    REQUIRED for any environment that is deliberately idle, because AWS FORCE-STARTS a
    stopped RDS instance after seven days. Without a recurring re-stop the instance
    quietly comes back and the saving disappears with nothing reporting it.

    Expression is evaluated in Asia/Ho_Chi_Minh. Every Sunday 01:00 local — comfortably
    inside the 7-day window:

        cron(0 1 ? * SUN *)

    Stopping an already-stopped instance fails with InvalidDBInstanceState, which is the
    DESIRED state rather than an error, so the target takes no retries and no DLQ.
  EOT
  type        = string
  default     = null
}

variable "wake_schedule" {
  type        = string
  default     = null
  description = <<-EOT
    Cron/rate expression for the REVERSE of `idle_schedule`: starts the RDS instance and
    scales both services back up. Null (the default) creates no wake schedules, no role and
    no policy — which is the correct setting for production, where the only intended wake is
    a release.

    This exists because "the deploy pipeline is the wake signal" is not sufficient on its
    own. It is right that develop should be up on the days it is being CHANGED, but it also
    has to be up on the days it is merely USED — finding it stopped on a morning nobody
    merged reads as an outage rather than as a saving, and RDS takes 4-5 minutes to become
    available, so it cannot be waited out.

    WEEKDAYS ONLY is the intended shape. A 7-day wake pays for two days a week nobody works,
    which is most of what idling this environment was worth:

        cron(0 8 ? * MON-FRI *)

    Evaluated in Asia/Ho_Chi_Minh, like `idle_schedule`.

    A SEPARATE IAM role from the idler, deliberately. The idler's policy is stop-only on the
    documented grounds that "a role that can also start an instance turns a scheduling
    mistake into a cost increase". That reasoning survives here by keeping the grants split:
    the waker holds rds:StartDBInstance and ecs:UpdateService, and the idler still holds no
    start permission of any kind. A fault in the wake cron can cost money and a fault in the
    idle cron can cost availability, but neither can now cause the other.

    THE WAKE COUNT IS A LITERAL 1, NOT min_count. This is the subtle part. `min_count = 0` is
    exactly what lets an idled service STAY at zero — with a floor of 1, Application Auto
    Scaling restores it within minutes and the idle never holds. So the floors cannot be
    raised to describe the woken state and this schedule cannot read them. 1 is also the
    count the deploy pipeline sets, so a wake and a deploy converge on one answer.

    Consequence worth stating: `desired_count` now has THREE out-of-band writers — the
    deploy, `idle_schedule`, and this. That is sanctioned because `desired_count` is under
    `ignore_changes` in the ecs-service module. A fourth writer in the form of a scheduled
    autoscaling action would NOT be, which is why this is built as ecs:UpdateService.
  EOT

  # `validation`, not a `check` block. A violated check emits
  # `Warning: Check block assertion failed` and the plan exits 0 — measured on OpenTofu
  # 1.12.3 — so a guard written that way would let exactly the state it forbids apply
  # cleanly. A cross-variable validation exits 1. Same reason the `cache` validation below
  # replaced a check.
  validation {
    # Waking an environment that nothing stops is strictly worse than not scheduling it:
    # it is started on a cron, never idled, and it LOOKS deliberate. The reverse is
    # legitimate — production idles and is woken only by a release — so this is asserted in
    # one direction only.
    condition     = var.wake_schedule == null || var.idle_schedule != null
    error_message = "wake_schedule is set but idle_schedule is null, so this environment would be started on a schedule and never stopped by one. Set idle_schedule as well, or remove wake_schedule. (idle without wake is fine — that is production today.)"
  }

  validation {
    # The mirror of the cache/floors rule. That one stops an idled environment from RUNNING
    # tasks with no cache; this stops a schedule being created that would START them.
    # Without it the two settings are individually valid and jointly produce the exact
    # state the other forbids — tasks up, no cache, VALKEY_URL resolving nowhere, token
    # denylist and rate limiter failing open — except on a timer, at 08:00, unattended.
    condition     = var.wake_schedule == null || var.cache.enabled
    error_message = "wake_schedule is set but cache.enabled is false. Waking would start tasks with no cache to reach: VALKEY_URL resolves nowhere and both the token denylist and the rate limiter fail open. Enable the cache, or remove wake_schedule."
  }
}


variable "cache" {
  description = <<-EOT
    Cache sizing. Encryption is NOT an option here: the module always enables KMS at
    rest and TLS in transit, so both environments get the same posture and the URL is
    always `rediss://`.

    `serverless` mode floors at roughly $90/month, so `node` is the default for both
    environments; a single cache.t4g.micro is about $12/month.
  EOT
  type = object({
    # Create the cache node at all. False is for an environment that is deliberately
    # idle: ElastiCache cannot be stopped, only deleted, so the node is the one component
    # of an idled environment that keeps billing (~$12/mo). Requires min_count = 0 on
    # BOTH services — the `check` block in main.tf enforces it, because a task without a
    # reachable cache does not fail loudly.
    enabled   = optional(bool, true)
    mode      = optional(string, "node")
    node_type = optional(string, "cache.t4g.micro")
  })
  default = {}

  # Moved here from a `check` block in main.tf, which did NOT enforce it. That block's
  # comment claimed "the plan fails instead of producing an environment that looks healthy";
  # a violated check actually emits `Warning: Check block assertion failed` and exits 0, so
  # the forbidden combination would have applied with a warning nobody reads in CI output.
  #
  # The combination matters because it fails QUIETLY: `VALKEY_URL` points at an unresolvable
  # host, and the token denylist and rate limiter both fail OPEN rather than erroring. So the
  # dangerous state is not "no cache" — it is "no cache, tasks running", which degrades two
  # security controls while every health check still answers 200.
  validation {
    condition     = var.cache.enabled || (var.api.min_count == 0 && var.worker.min_count == 0)
    error_message = "cache.enabled = false requires min_count = 0 on BOTH services. Without a cache, tasks do not fail loudly — VALKEY_URL resolves nowhere and the token denylist and rate limiter fail open. Set both floors to 0, or re-enable the cache."
  }
}

// ── Per-environment tuning ──────────────────────────────────────────────────────

variable "log_retention_days" {
  description = "CloudWatch log retention for api, worker and migrator. Production keeps 90 for SOC 2."
  type        = number
  default     = 90
}

variable "secrets_recovery_window_days" {
  description = <<-EOT
    Secrets Manager recovery window. 0 in develop so a destroy+redeploy cycle does
    not hit "secret scheduled for deletion"; production keeps a real window so a
    mistaken destroy is recoverable.
  EOT
  type        = number
  default     = 30
}

variable "secrets_bundle_name" {
  description = <<-EOT
    Name of the bundled secret, created as "<product>/<env>/<name>". Empty (default)
    keeps one Secrets Manager secret per entry. Setting this creates the bundle but
    does NOT switch anything onto it — see `secrets_use_bundle`.
  EOT
  type        = string
  default     = ""
}

variable "secrets_use_bundle" {
  description = <<-EOT
    Read secrets from the bundle instead of the standalone containers. Requires
    `secrets_bundle_name`, and requires the bundle to already hold every key — a
    reference to an absent key fails the task at boot.
  EOT
  type        = bool
  default     = false
}

variable "secrets_create_standalone" {
  description = <<-EOT
    Whether the per-entry standalone secrets still exist. Defaults to
    `!secrets_use_bundle`, which is correct outside a migration.

    Set TRUE alongside `secrets_use_bundle` for the retained-rollback step: both exist,
    references point at the bundle, and reverting one line rolls back without needing
    the destroyed values. Drop it once the bundle is proven to realise the saving.
  EOT
  type        = bool
  default     = null
}

variable "container_insights" {
  description = <<-EOT
    ECS Container Insights mode: "enhanced", "enabled" or "disabled".

    Stated here rather than inherited, because the ecs-cluster module defaults to
    "enhanced" and that default is expensive: enhanced adds per-task and per-container
    metrics that CloudWatch bills as CUSTOM metrics at $0.07 each, and the count grows
    with task churn rather than with traffic. Four clusters silently on that default
    produced 606 metric-months (~$42) on the July 2026 bill — this stack's cluster was
    one of them, because it never passed the variable.

    "disabled" because nothing in this product reads the ECS/ContainerInsights
    namespace: autoscaling targets read AWS/ECS, which is free and published either
    way, and application telemetry goes to OTLP rather than CloudWatch.

    Raise an environment to "enhanced" while debugging a per-container resource
    problem, then put it back.
  EOT
  type        = string
  default     = "disabled"

  validation {
    condition     = contains(["enhanced", "enabled", "disabled"], var.container_insights)
    error_message = "container_insights must be enhanced, enabled, or disabled."
  }
}

variable "rds" {
  description = "Database sizing and durability. No defaults for storage or protection — both callers state them explicitly, so neither is production-critical by accident."
  type = object({
    instance_class           = string
    allocated_storage_gb     = number
    max_allocated_storage_gb = number
    multi_az                 = bool
    deletion_protection      = bool
    backup_retention_days    = number
    monitoring_interval      = optional(number, 0)
  })
}

variable "api" {
  description = <<-EOT
    API service sizing and scaling.

    The autoscaling targets repeat the ecs-service module's own defaults (65/75) rather
    than defaulting to null. `null` is NOT "use the module's default" for a nested
    optional attribute — it is passed through as null, and
    `target_tracking_scaling_policy_configuration.target_value` is a required argument,
    so the plan fails outright. Restating the numbers keeps every environment's target
    explicit and reviewable.
  EOT
  type = object({
    cpu    = number
    memory = number
    # The FLOOR, and also the desired count at apply time. 0 parks the environment: it is
    # what makes `idle_schedule` hold, because Application Auto Scaling restores a service
    # within minutes of a scale-down when the floor is 1.
    min_count         = optional(number, 1)
    max_count         = number
    use_spot          = optional(bool, false)
    cpu_target_pct    = optional(number, 65)
    memory_target_pct = optional(number, 75)
    # Off for a schedule-driven environment, where autoscaling would fight
    # `idle_schedule` by restoring the task it just scaled to zero. On by default,
    # because a load-driven environment that silently stopped scaling is worse.
    enable_autoscaling = optional(bool, true)
  })

  # Target tracking scales on CPU and memory, and a service sitting at ZERO tasks publishes
  # neither — so nothing can ever scale it back out. `enable_autoscaling = true` with a floor
  # of 0 therefore describes a service that can reach zero and stay there, with the autoscaler
  # present and powerless.
  #
  # Both combinations that DO work are allowed: a floor of 1 with autoscaling on (production
  # shape), or a floor of 0 with autoscaling off, which is what lets `idle_schedule` hold and
  # leaves the count owned by the deploy and the wake schedule.
  #
  # A `validation`, so it fails a plan. Both environments already pair floor 0 with autoscaling
  # off, so this changes nothing today — it exists so the broken pairing cannot be introduced
  # while every plan stays green. Ported from rally, which had it and opshub did not.
  validation {
    condition     = !var.api.enable_autoscaling || var.api.min_count >= 1
    error_message = "api.enable_autoscaling = true requires min_count >= 1 (got ${var.api.min_count}). Target tracking scales on CPU and memory, which a service at zero tasks does not publish, so nothing can scale it back out — a floor of at least 1 is what restores capacity. Raise the floor, or set enable_autoscaling = false and let the deploy and idle_schedule own the count."
  }
}

variable "worker" {
  description = "Worker service sizing and scaling."
  type = object({
    cpu                = number
    memory             = number
    min_count          = optional(number, 1)
    max_count          = number
    use_spot           = optional(bool, false)
    enable_autoscaling = optional(bool, true)
  })

  # Target tracking scales on CPU and memory, and a service sitting at ZERO tasks publishes
  # neither — so nothing can ever scale it back out. `enable_autoscaling = true` with a floor
  # of 0 therefore describes a service that can reach zero and stay there, with the autoscaler
  # present and powerless.
  #
  # Both combinations that DO work are allowed: a floor of 1 with autoscaling on (production
  # shape), or a floor of 0 with autoscaling off, which is what lets `idle_schedule` hold and
  # leaves the count owned by the deploy and the wake schedule.
  #
  # A `validation`, so it fails a plan. Both environments already pair floor 0 with autoscaling
  # off, so this changes nothing today — it exists so the broken pairing cannot be introduced
  # while every plan stays green. Ported from rally, which had it and opshub did not.
  validation {
    condition     = !var.worker.enable_autoscaling || var.worker.min_count >= 1
    error_message = "worker.enable_autoscaling = true requires min_count >= 1 (got ${var.worker.min_count}). Target tracking scales on CPU and memory, which a service at zero tasks does not publish, so nothing can scale it back out — a floor of at least 1 is what restores capacity. Raise the floor, or set enable_autoscaling = false and let the deploy and idle_schedule own the count."
  }
}

variable "uploads" {
  description = <<-EOT
    The S3 upload bucket's environment-specific behaviour.

    `force_destroy` defaults to FALSE: an environment that wants its uploads deleted
    along with the bucket has to say so. `extra_cors_origins` is additive to the app's
    own origin (which is always allowed) and exists for local development against a
    deployed bucket — never populate it in production.
  EOT
  type = object({
    force_destroy      = optional(bool, false)
    extra_cors_origins = optional(list(string), [])
  })
  default = {}
}

variable "cloudflare_account_id" {
  description = "Cloudflare account that owns the Pages project (public identifier). Empty skips the Pages project entirely."
  type        = string
  default     = ""
}

// ── Observability ───────────────────────────────────────────────────────────────

variable "observability" {
  description = <<-EOT
    Telemetry export. `otlp_endpoint` is the master switch: while it is empty no collector
    sidecar is created, `OTEL_ENABLED` stays false, and the whole OTel path is dormant — so
    this can be adopted before a backend exists, at no cost.

    Turning it on is two steps, in this order:
      1. put the Authorization header in the `observability-token` secret
      2. set `otlp_endpoint` here
    Reversing them starts a collector that cannot authenticate.

    `sampling_probability` is HEAD sampling, the only lever the SDK has on its own. 1.0 in
    develop (volume is trivial and full fidelity is the point of enabling it there); lower in
    production for cost. Be aware that anything below 1.0 drops most ERROR traces too —
    keeping all errors needs tail sampling, which needs a gateway that sees whole traces
    rather than a per-task sidecar.

    This value is actually APPLIED: `resolveSampler` in
    libs/platform/src/observability/otel.ts builds a ParentBased/TraceIdRatio sampler from it,
    and otel.spec.ts asserts a configured probability changes the decisions. It was inert
    before that — declared here and in the env schema, and ignored by opshub's own OTel
    bootstrap, which had drifted behind the `@quynhonsemiconductor/observability` package rally uses.
  EOT
  type = object({
    otlp_endpoint        = optional(string, "")
    sampling_probability = optional(number, 1.0)
  })
  default = {}

  validation {
    condition     = var.observability.sampling_probability >= 0 && var.observability.sampling_probability <= 1
    error_message = "observability.sampling_probability is a probability: it must be between 0 and 1 inclusive."
  }
}

variable "monitor_ingress" {
  description = <<-EOT
    Create the Route 53 health check plus its us-east-1 alarm, probing the public api
    hostname from OUTSIDE AWS. Only meaningful when `tunnel_enabled` — with an ALB that job
    belongs to `monitor_target_health`.

    Why it is worth anything: a tunnelled environment has NO other ingress alarm. ECS reports
    a task RUNNING whether or not cloudflared holds edge connections, `essential = true`
    catches the sidecar CRASHING but not it sitting up with zero connections, and an ECS
    healthCheck cannot probe it because the cloudflared image is distroless and has no shell.
    So without this, an ingress outage is visible only when a person reports it.

    THE ZERO-TASK CASE IS HANDLED FOR YOU, so this variable is only for an environment that
    IS serving and still does not want the probe. `local.monitor_ingress` also requires
    `!local.environment_idle`, so an environment whose service floors are 0 creates no check
    at all — the same rule this stack already applies to the load alarms. Raising the floors
    re-arms it in the same change, rather than leaving a note asking someone to remember.

    That matters because a health check against a hostname with no tasks behind it sits in
    ALARM permanently: it pages for a condition that IS the intended state, and bills every
    month for that non-signal. rally hit exactly that — its develop had floors of 0, an idle
    schedule taking it to zero tasks nightly and all weekend, and this variable unset, so it
    paid for a probe that was red most of the week (fixed in quynhonsemiconductor/rally#393, which is
    where this derivation comes from).

    Default true, matching rally, because the idle gate makes true SAFE: it cannot create a
    check against an environment that is not serving.

    Cost, since this is the one guard here that bills per month rather than per alarm: one
    health check on a non-AWS endpoint, with `measure_latency = false` and no string match,
    so no optional-feature charge — plus one CloudWatch alarm and an SNS topic that costs
    nothing until it notifies. Worth stating precisely because rally's own comment quotes
    "$0.75 base + $2.00 for the string-match/latency option" while its resource enables
    NEITHER option, so that arithmetic describes something it did not build.
  EOT
  type        = bool
  default     = true
}

variable "monitor_target_health" {
  description = <<-EOT
    Create the per-service UnHealthyHostCount alarm.

    OFF by default, and irrelevant while `tunnel_enabled` is true: a tunnelled task has no
    ALB target group, so there is nothing for the alarm to read and no target group ARN is
    passed to the observability module.

    That is a REAL LOSS OF COVERAGE rather than mere plumbing — with no ALB, nothing on the
    AWS side observes ingress at all. ECS reports the task RUNNING whether or not cloudflared
    holds edge connections, and the sidecar's image is distroless so an ECS healthCheck
    cannot probe it either. Before relying on a tunnel in production, replace this from
    OUTSIDE AWS: a Cloudflare health check or a synthetic probe against the public hostname.
  EOT
  type        = bool
  default     = false
}

variable "create_dashboard" {
  description = <<-EOT
    Create the CloudWatch dashboard for this environment. Alarms are created either way.

    CloudWatch bills dashboards per ACCOUNT: three free, then $3/mo each. Two products at two
    environments is four, so the fourth starts charging. Develop is the one to drop — alarms
    are what page someone, a dashboard is what you open afterwards, and nobody opens
    develop's.
  EOT
  type        = bool
  default     = true
}

variable "alarm_emails" {
  description = "Addresses subscribed to the alarm topic. Terraform creates the subscription; each recipient must still confirm by email."
  type        = list(string)
  default     = []
}

variable "grafana_alerting_auth" {
  description = <<-EOT
    Stack service account token — qnsc-infra/live/observability's
    `alerting_service_account_token` output. A SEPARATE variable from
    `grafana_alerting` below, same reason as rally's own copy of this
    variable: it carries a raw secret value directly through Terraform, and
    `sensitive = true` only masks plan/apply output for a variable as a
    whole — nesting it into the config object would either blunt-hide the
    harmless fields alongside it or not mask this one at all.

    The master switch: while empty, `module.alerts` and the Grafana
    dashboards/SLO below are not created at all — count, not a dormant
    no-op module. CloudWatch Alarms (create_dashboard, above) are
    unaffected either way.

    Reaches Terraform via TF_VAR_grafana_alerting_auth in CI
    (GRAFANA_ALERTS_TOKEN secret) — NEVER through AWS Secrets Manager,
    unlike the OTLP token: this credential is needed at PLAN/APPLY time
    only, nothing running in a task ever calls the Grafana instance API.
  EOT
  type        = string
  sensitive   = true
  default     = ""
}

variable "grafana_alerting" {
  description = <<-EOT
    Grafana Alerting + Dashboards config, ALONGSIDE CloudWatch Alarms, not
    replacing them — CloudWatch stays on infra-level signals it can see
    directly; this covers only what CloudWatch cannot (HTTP error rate,
    latency, worker job failure rate, login failure rate) plus opshub's own
    dashboards. None of these fields are secret — see
    `grafana_alerting_auth` for the one that is.

    `alerts_folder_uid`, `dashboards_folder_uid` and
    `product_dashboards_folder_uid` are THREE DIFFERENT folders in the same
    shared Grafana stack — do not collapse them, and do not repeat rally's
    own real bug of reusing `alerts_folder_uid` for the dashboard resource.
    `product_dashboards_folder_uid` is qnsc-infra/live/observability's
    `opshub_dashboards_folder_uid` output — created ONCE, centrally, exactly
    like rally's own subfolder, not re-derived per environment (rally hit a
    real duplicate-folder bug doing that: develop and prod are separate
    Terraform root modules with separate state, so a `grafana_folder`
    resource created HERE would create two separate "Opshub" folders).
  EOT
  type = object({
    url                           = optional(string, "https://qnsc.grafana.net")
    prometheus_datasource_name    = optional(string, "grafanacloud-qnsc-prom")
    logs_datasource_name          = optional(string, "grafanacloud-qnsc-logs")
    traces_datasource_name        = optional(string, "grafanacloud-qnsc-traces")
    alerts_folder_uid             = optional(string, "")
    dashboards_folder_uid         = optional(string, "")
    product_dashboards_folder_uid = optional(string, "")
    slos_folder_uid               = optional(string, "")
  })
  default = {}
}

# ── Outbound email ────────────────────────────────────────────────────────────

variable "email_provider" {
  description = <<-EOT
    Which transport sends mail: "dev" logs and sends nothing, "ses" uses this account's SES.

    Defaults to "dev" so applying this module changes nothing about mail until somebody chooses to
    turn it on. Choosing "ses" needs `mail_from_email` set AND the sender's domain verified in SES —
    the IAM grant below is created either way, and grants nothing when there is no sender.
  EOT
  type        = string
  default     = "dev"

  validation {
    condition     = contains(["dev", "ses", "resend"], var.email_provider)
    error_message = "email_provider must be dev, ses or resend."
  }
}

variable "mail_from_email" {
  description = <<-EOT
    The verified sender address, e.g. no-reply@opshub.example.com.

    NO DEFAULT, deliberately. The app used to default this to a domain a deployment may not own, and
    the result was not a failure: mail went out failing SPF and DKIM, which is silent non-delivery or
    delivery to spam. Empty is the honest value when mail is off, and the app refuses to boot with a
    non-dev provider and no sender.
  EOT
  type        = string
  default     = ""

  validation {
    condition     = var.email_provider == "dev" || var.mail_from_email != ""
    error_message = "mail_from_email is required when email_provider is not \"dev\"."
  }
}

variable "mail_from_name" {
  description = "Display name on outgoing mail."
  type        = string
  default     = "OpsHub"
}

variable "mail_reply_to" {
  description = <<-EOT
    Where replies go. Empty means they land on the no-reply sender.

    Worth setting once a human is on the other end of anything the product sends: a reply to a
    notification is a reply to nobody otherwise.
  EOT
  type        = string
  default     = ""
}

variable "cpu_architecture" {
  type    = string
  default = "X86_64"
  validation {
    condition     = contains(["X86_64", "ARM64"], var.cpu_architecture)
    error_message = "cpu_architecture must be X86_64 or ARM64."
  }
  description = <<-EOT
    Fargate CPU architecture for the api, worker and migrator: "X86_64" or "ARM64".

    ARM64 (Graviton) bills ~20% less per vCPU-hour and GB-hour for identical sizing, with
    no capability difference — same Fargate platform, same networking, same limits.

    IT IS NOT A FREE FLAG. The image must be built for linux/arm64, or the container fails
    at start with "image Manifest does not contain descriptor matching platform" — a
    failure that appears at TASK START, after a clean apply and a deploy that reports a
    rollout. So this moves together with `build_runner` and `image_platforms` in the
    caller's deploy workflow, in one change, and the three task definitions here move
    together with each other: the migrator runs the same image family as the api.

    Build NATIVELY on an ARM runner (`ubuntu-24.04-arm`), not under QEMU emulation. The
    ci reusable's own note is explicit that emulating an arm64 pnpm + Nest compile on
    an x86 runner multiplies build minutes by enough to outweigh the Fargate saving.

    NOT EVERY PRODUCT CAN TAKE THIS. It depends on every image in the task having an arm64
    build, INCLUDING SIDECARS, and a sidecar is the easy one to forget because nothing in
    this repo names its image — the agent modules carry them as defaults. opshub's three
    were checked with `docker manifest inspect` rather than from documentation, on
    2026-08-31, and all three publish arm64 alongside amd64:

      public.ecr.aws/aws-observability/aws-for-fluent-bit:init-3.4.14   (firelens-agent)
      public.ecr.aws/aws-observability/aws-otel-collector:v0.43.3       (otel agent)
      cloudflare/cloudflared:2026.6.1                                   (tunnel-agent)

    cloudflared is in the api task only where `tunnel_enabled` is true, which today is
    develop. RE-CHECK ON A SIDECAR BUMP: an image pin that moves to an amd64-only tag
    breaks task start, and none of these modules would fail an apply over it. qnsc-kb is
    the counter-example on the same point — `clamav/clamav` is amd64-only on every
    published tag, so that product cannot take ARM64 at all.

    Defaults to X86_64 so a caller that has not moved its build keeps working.
  EOT
}
