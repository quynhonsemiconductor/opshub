// opshub · production
//
// Thin by design: the stack lives in ../../modules/stack, so this environment can only
// differ from develop in the values below. Production takes the durable settings —
// on-demand capacity, deletion protection, 90-day retention, a real secret recovery
// window.
//
// NOT YET APPLIED. There is no `opshub/prod/terraform.tfstate`, so this file describes
// the environment that the first v*.*.* tag will create. The go-live checklist on the
// `rds` block below is part of that first apply, not a later hardening pass.
terraform {
  required_version = ">= 1.9"
  required_providers {
    aws        = { source = "hashicorp/aws", version = "~> 5.0" }
    cloudflare = { source = "cloudflare/cloudflare", version = "~> 4.0" }
    grafana    = { source = "grafana/grafana", version = "~> 3.0" }
  }

  backend "s3" {
    bucket         = "qnsc-tofu-state"
    key            = "opshub/prod/terraform.tfstate"
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
      Environment = "production"
      ManagedBy   = "opentofu"
    }
  }
}

// Route 53 publishes health-check metrics ONLY to us-east-1, so the ingress alarm has to
// be created there even though every other resource is in ap-southeast-1. Same credentials,
// different region — this is not a second account.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
  default_tags {
    tags = {
      Project     = "opshub"
      Environment = "prod"
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

  product = "opshub"
  env     = "production"
  // Resources are named `opshub-prod`, not `opshub-production`: renaming them later
  // would force replacement of the cluster, the RDS instance and every log group.
  env_slug = "prod"
  region   = local.region

  app_domain = "opshub.qnsc.vn"
  api_domain = "opshub-api.qnsc.vn"
  web_record = "opshub"
  api_record = "opshub-api"

  shared_state_key  = "opshub/shared/terraform.tfstate"
  runtime_state_key = "platform/runtime-prod/terraform.tfstate"

  // The tag that triggered the apply, never a floating `latest` — infra-apply.yml
  // passes github.ref_name, so an infra apply can never quietly move production onto
  // a different image than the release it belongs to.
  image_tag = var.image_tag

  entra_tenant_id = var.entra_tenant_id
  entra_client_id = var.entra_client_id

  // 90 days is the SOC 2 minimum; the recovery window keeps a mistaken destroy
  // recoverable.
  log_retention_days           = 90
  secrets_recovery_window_days = 30

  // OFF, including here. Nothing in this product reads the ECS/ContainerInsights
  // namespace: the autoscaling targets read AWS/ECS, which is free and published
  // whether Container Insights is on or off, and application telemetry goes to OTLP.
  // Raise it to "enhanced" temporarily during an incident that needs per-container
  // drilldown, then put it back.
  container_insights = "disabled"

  // PRE-LAUNCH sizing. Multi-AZ with Enhanced Monitoring is the right production
  // posture, and it is what this becomes at go-live — but Multi-AZ doubles the
  // instance rate AND bills the mirrored volume, so paying for it before the first
  // user buys durability for an empty database.
  //
  // GO-LIVE CHECKLIST — flip these together, before the first real user:
  //     instance_class      = "db.t4g.small"  # 2 GB rather than 1 GB
  //     multi_az            = true            # an AZ failure becomes a failover,
  //                                           # not an outage plus a restore
  //     monitoring_interval = 60              # per-process and per-device visibility
  //
  // 30 GB, not 100: `max_allocated_storage_gb` already autoscales, and RDS gp3 gives
  // the same 3,000 baseline IOPS at every size under 400 GB, so over-allocating buys
  // nothing. Treat any increase as PERMANENT — RDS refuses to shrink a volume and a
  // snapshot restore cannot land smaller, so coming back down needs the instance
  // replaced.
  // ── Ingress: no ALB exists any more ─────────────────────────────────────────
  // Same as develop — see ../develop/main.tf for the three out-of-band steps. Production
  // has never been applied, so there is nothing to migrate: whenever it first runs, it
  // runs tunnelled or not at all.
  tunnel_enabled = false
  tunnel_id      = ""

  // ── Provisioned but idle, until go-live ─────────────────────────────────────
  // Weekly, comfortably inside the window that matters: AWS FORCE-STARTS a stopped RDS
  // instance after SEVEN DAYS, so without a recurring re-stop the saving silently
  // evaporates and nothing reports it.
  //
  // REMOVE THIS AT GO-LIVE, in the same change that restores min_count and re-enables the
  // cache. A schedule that stops production every Sunday is precisely wrong once there
  // are users.
  idle_schedule = "cron(0 1 ? * SUN *)"

  rds = {
    instance_class           = "db.t4g.micro"
    allocated_storage_gb     = 30
    max_allocated_storage_gb = 500
    multi_az                 = false
    deletion_protection      = true
    backup_retention_days    = 30
    monitoring_interval      = 0
  }

  // On-demand, not Spot: an interruption here is user-visible. Tighter autoscale
  // targets than develop, so it scales out earlier.
  // Floors at 0 and autoscaling off while production is idle. RESTORE BOTH AT GO-LIVE,
  // in the same change that removes `idle_schedule` and re-enables the cache — they are
  // one decision, and applying them separately produces an environment that is either
  // paying for nothing or serving nothing.
  api = {
    cpu                = 1024
    memory             = 2048
    min_count          = 0
    max_count          = 6
    use_spot           = false
    cpu_target_pct     = 60
    memory_target_pct  = 70
    enable_autoscaling = false
  }

  worker = {
    cpu                = 512
    memory             = 1024
    min_count          = 0
    max_count          = 4
    use_spot           = false
    enable_autoscaling = false
  }

  // ElastiCache cannot be stopped, only deleted, so the node is the one component of an
  // idled environment that keeps billing (~$12/mo). The `check` block in the stack module
  // enforces that this requires min_count = 0 on both services: a task without a
  // reachable cache does NOT fail loudly — REDIS_URL is optional and both the token
  // denylist and the rate limiter fail open — so "no cache, tasks running" would degrade
  // two security controls silently. RE-ENABLE AT GO-LIVE.
  cache = {
    enabled = false
  }

  // `force_destroy` stays false and no extra CORS origin is allowed: production
  // uploads are never auto-deleted, and only the SPA's own origin may PUT.
  uploads = {}

  cloudflare_account_id = var.cloudflare_account_id

  // Dormant until otlp_endpoint is set — see develop. Production would want a probability
  // BELOW 1 for cost once a backend exists; be aware that head sampling drops most ERROR
  // traces too, so keeping all errors needs tail sampling at a gateway that sees whole traces.
  observability = {
    otlp_endpoint        = var.otlp_endpoint
    sampling_probability = 1.0
  }

  // Production gets the dashboard: it is what you open after an alarm pages you.
  create_dashboard = true

  // Cannot be satisfied while the api is tunnelled — there is no target group. This is a REAL
  // gap in production, not just plumbing: with no ALB, nothing on the AWS side observes
  // ingress. ECS reports the task RUNNING whether or not cloudflared holds edge connections,
  // and the sidecar is distroless so an ECS healthCheck cannot probe it. Replace it from
  // OUTSIDE AWS — a Cloudflare health check or a synthetic probe on the public hostname —
  // before production depends on the tunnel.
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
