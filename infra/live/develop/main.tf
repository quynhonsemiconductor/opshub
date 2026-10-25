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

// Reads CLOUDFLARE_API_TOKEN (or TF_VAR_cloudflare_api_token). DNS/Pages resources exist when
// `dns_enabled` is true; the zone id comes from the _shared stack and must be valid or the plan fails.
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

// ============================================================================
// AWS EXIT (E1, 2026-10-31): this develop stack is being destroyed.
//
// Everything below the provider blocks was removed so `tofu plan` shows the
// full destroy set — a deleted directory plans nothing and proves nothing.
//
// Order of operations (product-docs/platform/runbooks/aws-exit-teardown.md):
//   1. copy-out checklist done (secrets -> kv-qnsc-dev)
//   2. no final RDS snapshot needed — opshub dev data is DISPOSABLE (owner,
//      recorded in the cutover doc); the opshub-prod final snapshots already
//      exist from the 2026-10-22 prod teardown
//   3. merge with the `allow-dns-destroy` label (dev records + tunnel)
//   4. `infra/live/_shared` is destroyed by the follow-up PR, AFTER this one
// ============================================================================
