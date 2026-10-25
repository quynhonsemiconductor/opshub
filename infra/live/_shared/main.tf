terraform {
  required_version = ">= 1.9"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }

  backend "s3" {
    bucket         = "qnsc-tofu-state"
    key            = "opshub/shared/terraform.tfstate"
    region         = "ap-southeast-1"
    encrypt        = true
    dynamodb_table = "qnsc-tofu-locks"
  }
}

provider "aws" {
  region = "ap-southeast-1"
  default_tags {
    tags = {
      Project   = "opshub"
      Scope     = "shared"
      ManagedBy = "opentofu"
    }
  }
}

# github_org is declared in variables.tf (with a quynhonsemiconductor default).

# ── Platform remote state (OIDC provider ARN + KMS from qnsc-infra) ───────────

// ============================================================================
// AWS EXIT (E1, 2026-10-31): the shared stack is being destroyed.
//
// ECR repositories (image fallback now lives in GHCR — gitops#33), the GitHub
// OIDC provider + deploy roles, and the SES bounce pipeline all go. The two
// deploy_rds_* guard policies die with it; there is no rova-style prod
// dependency: opshub production was destroyed on 2026-10-22 (#464).
//
// MERGE ORDER: strictly AFTER the develop-stack destroy PR. The develop ECS
// deploy roles assume from this stack's OIDC provider; CI deploys to develop
// stop with this merge. Draft until the owner's go.
// ============================================================================
