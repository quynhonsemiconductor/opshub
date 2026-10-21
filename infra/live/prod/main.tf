// opshub · production — DESTROYED (owner decision, 2026-10-21)
//
// opshub never served production traffic (no prod ever ran; the environment was
// provisioned, idled and weekly-stopped), and the on-prem plan gives opshub no
// prod at all. This file once composed the full stack via ../../modules/stack;
// it is now deliberately EMPTY: the next apply-prod run plans the removal of
// every resource in `opshub/prod/terraform.tfstate` and applies it, through the
// SAME gates as any prod change — the `production` Environment reviewer,
// plan-guard, destructive-guard and `.allow-data-destroy` (this directory).
//
// Owner runbook, IN ORDER, before that apply:
//   1. Final manual RDS snapshot + wait for it (identifier is `opshub-prod`;
//      `opshub-prod-db` is the SUBNET GROUP). Tofu will also cut its own final
//      snapshot `opshub-prod-final` — deletion protection was on with
//      skip_final_snapshot=false — that one is fine and non-configurable.
//        export AWS_PROFILE=qnsc-admin AWS_REGION=ap-southeast-1 AWS_PAGER=""
//        aws rds create-db-snapshot \
//          --db-instance-identifier opshub-prod \
//          --db-snapshot-identifier opshub-prod-final-2026-10-21 \
//          --profile qnsc-admin
//        aws rds wait db-snapshot-available \
//          --db-instance-identifier opshub-prod \
//          --db-snapshot-identifier opshub-prod-final-2026-10-21 \
//          --profile qnsc-admin
//   2. Remove deletion protection (a protected instance refuses the destroy):
//        aws rds modify-db-instance --db-instance-identifier opshub-prod \
//          --no-deletion-protection --apply-immediately --profile qnsc-admin
//   3. The uploads bucket is `opshub-production-uploads` and VERSIONED — an
//      empty-looking bucket can still hold old versions:
//        aws s3api list-object-versions --bucket opshub-production-uploads \
//          --profile qnsc-admin
//      Empty output = clear to apply. If versions exist, the owner decides
//      where they go BEFORE applying (they are uploads of a product that never
//      served prod traffic).
//   4. Push the teardown tag and approve the `production` environment. The run
//      prints every destroy; the SNS topic `opshub-prod-alarms`, SES set, SQS,
//      CloudWatch alarms, secrets (30-day recovery window), the Pages project,
//      DNS records and the tunnel go with it.
//
// The empty state file `opshub/prod/terraform.tfstate` stays in the bucket until
// the AWS wind-down (the platform plan's §15.3) deletes it with the rest.
// `develop` and `_shared` are UNTOUCHED — they run opshub dev on-prem after the
// move.
//
// The known drift on this stack — the never-read `jwt-private` and
// `graph-client-secret` secrets and the ALB target group the tunnel cutover
// orphaned — is moot here: destroy does not consult drift.

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

# PROVIDERS STAY UNTIL THE DESTROY IS DONE: refresh and delete need them.
#  - aws + the us-east-1 alias: state holds aws_sns_topic.ingress_alarms_us_east_1
#    and the api-ingress alarm (Route 53 health-check metrics live in us-east-1).
#  - cloudflare: the Pages project, domains, DNS records and tunnels are in state.
#  - grafana: the dashboards + SLO are in state. Configured UNCONDITIONALLY (a
#    provider cannot be conditional); touches nothing while grafana_alerting_auth
#    is empty, and destroy-prod passes the TF_VAR like apply-prod did.
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

provider "grafana" {
  url  = var.grafana_alerting_url
  auth = var.grafana_alerting_auth
}

# Intentionally no resources: an empty configuration against this backend is a
# full-state prune. The variables that remain feed the providers only.
