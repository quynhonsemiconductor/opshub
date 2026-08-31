// opshub · develop
//
// This file is deliberately thin. The entire stack lives in ../../modules/stack, so
// develop and production cannot drift structurally — only the values below differ.
// Develop leans on cheap infrastructure (Fargate Spot, small RDS, short retention);
// production takes the durable settings. Adding a resource means editing the module
// once, not both environments.
terraform {
  required_version = ">= 1.9"
  required_providers {
    aws        = { source = "hashicorp/aws", version = "~> 5.0" }
    cloudflare = { source = "cloudflare/cloudflare", version = "~> 4.0" }
    grafana    = { source = "grafana/grafana", version = "~> 3.0" }
  }

  backend "s3" {
    bucket         = "qnsc-tofu-state"
    key            = "opshub/develop/terraform.tfstate"
    region         = "ap-southeast-1"
    encrypt        = true
    dynamodb_table = "qnsc-tofu-locks"
  }
}

provider "aws" {
  region = "ap-southeast-1"
  default_tags {
    tags = {
      Project     = "opshub"
      Environment = "develop"
      ManagedBy   = "opentofu"
    }
  }
}

// Reads CLOUDFLARE_API_TOKEN (or TF_VAR_cloudflare_api_token). DNS/Pages resources
// are skipped when the zone is unset, so the stack applies before Cloudflare exists.
// Route 53 publishes health-check metrics ONLY to us-east-1, so the ingress alarm has to
// be created there even though every other resource is in ap-southeast-1. Same credentials,
// different region — this is not a second account.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
  default_tags {
    tags = {
      Project     = "opshub"
      Environment = "develop"
      ManagedBy   = "opentofu"
    }
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token != "" ? var.cloudflare_api_token : null
}

// Configured UNCONDITIONALLY, like the cloudflare provider above — providers can't
// be conditional — but touches nothing at all while grafana_alerting_auth is empty:
// module.alerts (inside module.stack) is count-gated to zero in that state. See
// modules/stack/variables.tf's grafana_alerting_auth for the full reasoning.
provider "grafana" {
  url  = var.grafana_alerting_url
  auth = var.grafana_alerting_auth
}

locals {
  region = "ap-southeast-1"
}

// ── The stack ─────────────────────────────────────────────────────────────────
module "stack" {
  source = "../../modules/stack"

  // Required by the stack module: it declares `aws.us_east_1` as a configuration alias for
  // the Route 53 ingress alarm. Listing `aws` too is not optional — supplying a providers
  // map replaces inheritance rather than adding to it.
  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  product  = "opshub"
  env      = "develop"
  env_slug = "develop"
  region   = local.region

  app_domain = "opshub-dev.qnsc.vn"
  api_domain = "opshub-api-dev.qnsc.vn"
  web_record = "opshub-dev"
  api_record = "opshub-api-dev"

  shared_state_key  = "opshub/shared/terraform.tfstate"
  runtime_state_key = "platform/runtime-dev/terraform.tfstate"

  // Develop tracks the newest image; production pins the release tag.
  image_tag = "latest"

  entra_tenant_id = var.entra_tenant_id
  entra_client_id = var.entra_client_id

  // Both secrets are populated in Secrets Manager (opshub/develop/entra-client-secret,
  // opshub/develop/graph-client-secret) — this is the second, ordered step that actually
  // wires them into api/worker. See the two variables' descriptions in modules/stack for
  // why this is staged rather than unconditional.
  entra_client_secret_set = true
  graph_client_secret_set = true

  // qnsc.vn is a verified SES domain identity in this account (rally already sends from
  // it). A distinct local-part from rally's own noreply@qnsc.vn keeps bounce/reply
  // routing distinguishable per product, though the domain-level identity would permit
  // either. SES_CONFIGURATION_SET is NOT set here — it's derived automatically from the
  // real aws_sesv2_configuration_set.email_feedback resource this module now creates.
  email_provider  = "ses"
  mail_from_email = "opshub-noreply@qnsc.vn"

  // Cost-leaning: short retention, immediate secret deletion so a destroy+redeploy
  // cycle does not trip "secret scheduled for deletion".
  log_retention_days           = 7
  secrets_recovery_window_days = 0

  // Step 1 of the staged migration to a bundled secret (see
  // infra/modules/stack/variables.tf's secrets_bundle_name for why it's staged):
  // creates opshub/develop/app, empty, alongside the existing standalone secrets.
  // secrets_use_bundle stays unset (false) — nothing reads from it yet.
  secrets_bundle_name = "app"

  // OFF here and in production alike — see ../prod/main.tf. Per-task metrics are
  // billed as custom CloudWatch metrics and nothing in this product queries them.
  container_insights = "disabled"

  // ── Ingress: no ALB exists any more ─────────────────────────────────────────
  // The shared ALBs in qnsc-infra/live/runtime-{dev,prod} were DELETED once both
  // products moved to Cloudflare Tunnels, so `https_listener_arn` is null and there is
  // nothing to attach to. Unlike rally (which had to ADOPT two tunnels already created
  // by hand in the dashboard), opshub has never had one — module.tunnel (the shared
  // cf-tunnel module) creates it, its connector token and its routing rule outright, so
  // turning this on is the only step needed. The alternative is `enable_alb = true` in
  // runtime-dev, at $18.40/mo + $3.65 per AZ.
  tunnel_enabled = true

  // ── Graviton ────────────────────────────────────────────────────────────────
  // ARM64 bills ~20% less per vCPU-hour and GB-hour than X86_64 for identical sizing,
  // with no capability difference. rally has run this since its own build moved; opshub
  // was still on the module's X86_64 default, which is drift rather than a decision — it
  // is not recorded in docs/DIVERGENCE.md, and nothing about opshub's workload argues for
  // x86.
  //
  // THIS LINE ALONE IS NOT ENOUGH, and getting it half-done fails at TASK START rather
  // than at apply: the images must be built for linux/arm64 too. That is
  // `build_runner: ubuntu-24.04-arm` + `image_platforms: linux/arm64` in
  // .github/workflows/backend-deploy.yml, and they land in the SAME COMMIT as this. The
  // `wait-for-infra` gate is what makes one commit safe — it holds the deploy until this
  // apply finishes, so the ARM64 task definition exists before the deploy that builds
  // arm64 images rolls onto it. Both halves in one commit, or neither.
  //
  // Every sidecar was checked for an arm64 build with `docker manifest inspect` (see the
  // stack variable's description for the three images and the result). Re-check on a
  // sidecar image bump.
  cpu_architecture = "ARM64"

  // ── Parked between deploys ──────────────────────────────────────────────────
  // Twice daily, matching rally. Develop is exercised by CI deploys and the occasional
  // manual poke, so the useful default is "down unless something just deployed": the
  // deploy pipeline wakes RDS and restores the desired count, and this puts it back.
  idle_schedule = "cron(0 21,3 * * ? *)"

  // 08:00 local, MON-FRI. The weekday restriction is the entire cost control here: a 7-day
  // wake would pay for two days a week nobody works, which is a large share of what idling
  // develop was worth in the first place.
  //
  // 08:00 rather than 09:00 because RDS takes 4-5 minutes to reach `available` and the api
  // tasks then need to pass readiness, so the environment is serving by roughly 08:10 —
  // before the working day rather than during its first minutes.
  //
  // This does NOT conflict with the 03:00 stop above. 03:00 fires while develop is already
  // down (a no-op: InvalidDBInstanceState, deliberately not retried) and 08:00 brings it up
  // five hours later. The 21:00 stop then ends the day. A deploy landing at any hour still
  // wakes it independently — that path is unchanged.
  //
  // Net effect: develop moves from "up on merge days only" to roughly 13h/day on weekdays
  // and 0h at weekends. So this BUYS availability rather than saving money; the saving comes
  // from the weekends and the 21:00-08:00 window, which the idle schedule already owned.
  wake_schedule = "cron(0 8 ? * MON-FRI *)"

  rds = {
    instance_class           = "db.t4g.micro"
    allocated_storage_gb     = 20
    max_allocated_storage_gb = 100
    multi_az                 = false
    deletion_protection      = false # easy teardown in develop
    backup_retention_days    = 3
    monitoring_interval      = 0 # Enhanced Monitoring off — saves CloudWatch cost
  }

  // Fargate Spot: ~70% cheaper, and an interruption in develop is harmless.
  // `min_count = 0` on both services is what makes `idle_schedule` hold: with a floor of
  // 1, Application Auto Scaling puts the task back within minutes of the scale-down.
  // Deploys and the schedule between them own the desired count.
  //
  // `enable_autoscaling = false` says out loud that this environment is schedule-driven,
  // not load-driven — and stops autoscaling fighting the idler. `max_count` stays set: it
  // no longer drives scaling, but it still sizes the DB connection pool.
  api = {
    cpu                = 512
    memory             = 1024
    min_count          = 0
    max_count          = 3
    use_spot           = true
    enable_autoscaling = false
  }

  worker = {
    cpu                = 256
    memory             = 512
    min_count          = 0
    max_count          = 2
    use_spot           = true
    enable_autoscaling = false
  }

  uploads = {
    // Develop's uploads are disposable, and a bucket that refuses to delete blocks
    // the whole teardown.
    force_destroy = true
    // The Vite dev server, so a local SPA can PUT to this bucket. Never in prod.
    extra_cors_origins = ["http://localhost:5174"]
  }

  cloudflare_account_id = var.cloudflare_account_id

  // Telemetry stays DORMANT until otlp_endpoint is set: no collector sidecar, OTEL_ENABLED
  // false, no observability-token secret created. Put the Authorization header in that secret
  // FIRST, then set this — reversing the order starts a collector that cannot authenticate.
  observability = {
    otlp_endpoint = var.otlp_endpoint
    // Full fidelity: develop volume is trivial, and validating the instrumentation is the
    // only reason to enable it here at all. Applied by resolveSampler in
    // libs/platform/src/observability/otel.ts, and asserted by otel.spec.ts.
    sampling_probability = 1.0
  }

  // No dashboard in develop. CloudWatch bills dashboards per ACCOUNT — three free, then
  // $3/mo — and nobody opens develop's. Alarms are created either way, and alarms are what
  // page someone.
  create_dashboard = false

  // Left OFF, and it would be inert anyway while the api is tunnelled: no ALB target group
  // means no UnHealthyHostCount metric to alarm on.
  monitor_target_health = false

  alarm_emails = var.alarm_emails

  grafana_alerting_auth = var.grafana_alerting_auth
  grafana_alerting = {
    url                           = var.grafana_alerting_url
    prometheus_datasource_name    = var.grafana_alerting_prometheus_datasource_name
    logs_datasource_name          = var.grafana_logs_datasource_name
    alerts_folder_uid             = var.grafana_alerting_folder_uid
    dashboards_folder_uid         = var.grafana_dashboards_folder_uid
    product_dashboards_folder_uid = var.grafana_opshub_dashboards_folder_uid
    slos_folder_uid               = var.grafana_slos_folder_uid
  }
}
