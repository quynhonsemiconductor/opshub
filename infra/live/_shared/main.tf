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
data "terraform_remote_state" "platform" {
  backend = "s3"
  config = {
    bucket = "qnsc-tofu-state"
    key    = "platform/bootstrap/terraform.tfstate"
    region = "ap-southeast-1"
  }
}

# ── Container registries ──────────────────────────────────────────────────────
module "ecr" {
  # ecr-v2.0.0 splits the keep-count lifecycle rule by tag prefix. The single rule it
  # replaces was provably dead: `tagPrefixList` is AND, not OR, so one rule listing
  # ["sha-", "v"] only ever selected images carrying BOTH prefixes and never fired.
  # rally verified that on live repositories (105 `sha-` images under a policy claiming
  # to keep 30).
  #
  # No argument change is needed here: this call never set `keep_tagged_count` or
  # `tag_prefix_list`, so it simply adopts the new defaults — keep 30 releases (v*) and
  # 20 builds (sha-*). These repositories do not exist yet, so unlike rally there is
  # nothing to preview: the policy applies from the first pushed image. Run
  # `aws ecr start-lifecycle-policy-preview` before changing the counts later — it is a
  # dry run and the only way to see what a policy will delete.
  source = "git::https://github.com/quynhonsemiconductor/tf-modules.git//modules/ecr?ref=ecr-v2.0.0"

  repository_names     = ["opshub-api", "opshub-worker", "opshub-migrator"]
  image_tag_mutability = "MUTABLE" # allows re-tagging :latest
  kms_key_arn          = data.terraform_remote_state.platform.outputs.kms_key_arn
  tags                 = { Scope = "shared" }
}

# ── GitHub Actions OIDC roles (ECS deploy + ECR push + infra CI) ─────────────
# Owns ALL opshub AWS deploy roles: API (per-env), ECR push, infra plan/apply.
# The web SPA deploys to Cloudflare Pages (see web-deploy.yml → wrangler pages
# deploy), so it needs no AWS deploy role. opshub is a monorepo; subjects use the
# "opshub" repo (the archived "opshub-api"/"opshub-web" split repos are dead).
module "iam_oidc" {
  # iam-oidc-v3.0.0: the major came from a batched cost-posture release across several
  # modules, not from a change to this one — its variables and role names are identical
  # to v2.0.1 (verified by diffing both). Taking it now rather than later because these
  # roles do not exist yet, so there is no trust-policy replacement to sequence.
  source = "git::https://github.com/quynhonsemiconductor/tf-modules.git//modules/iam-oidc?ref=iam-oidc-v3.0.1"

  product           = "opshub"
  github_org        = var.github_org
  oidc_provider_arn = data.terraform_remote_state.platform.outputs.oidc_provider_arn

  environments = {
    develop = {
      allowed_subjects = [
        "repo:${var.github_org}/opshub:ref:refs/heads/main",
        "repo:${var.github_org}/opshub:environment:develop",
      ]
    }
    production = {
      allowed_subjects = [
        "repo:${var.github_org}/opshub:ref:refs/heads/main",
        "repo:${var.github_org}/opshub:ref:refs/tags/v*",
        "repo:${var.github_org}/opshub:environment:production",
      ]
    }
  }

  app_repo_names         = ["opshub"]
  infra_repo_name        = "opshub"
  ecr_repository_pattern = "opshub-*"
  ecs_passrole_pattern   = "opshub-*"

  tags = { Scope = "shared" }

  # infra_plan_subjects / infra_apply_subjects: opshub's infra-apply jobs run in
  # the shared/develop/production GitHub Environments (see infra-apply.yml), which
  # exactly match the module defaults — so no override is needed.

  # Blast-radius guardrail: explicit-Deny on the opshub infra-apply role so a buggy
  # opshub apply cannot destroy the platform's own foundations (state bucket, lock
  # table, OIDC provider, CMK) or mint IAM users — all owned by qnsc-infra bootstrap.
  infra_apply_guardrail = {
    state_bucket_arn     = "arn:aws:s3:::qnsc-tofu-state"
    lock_table_arn       = "arn:aws:dynamodb:ap-southeast-1:${data.aws_caller_identity.current.account_id}:table/qnsc-tofu-locks"
    oidc_provider_arn    = data.terraform_remote_state.platform.outputs.oidc_provider_arn
    kms_key_arn          = data.terraform_remote_state.platform.outputs.kms_key_arn
    artifacts_bucket_arn = data.terraform_remote_state.platform.outputs.artifacts_bucket_arn
  }
}

# ── RDS dev-cost-saver guard — develop deploy role only ──────────────────────
# Allows the CI deploy job to detect + start a stopped RDS instance before
# running migrations. Scoped to develop only; prod RDS is always-on and this
# permission is intentionally absent from the production deploy role.
#
# The ARN is constructed directly (account_id + region + fixed identifier)
# instead of via a `data "aws_db_instance"` lookup. A data-source lookup
# fails hard whenever the instance doesn't exist yet or has been torn down
# (e.g. a fresh deploy, or a full teardown+redeploy cycle) — this stack
# would then be unable to apply/destroy independently of develop's RDS
# lifecycle. An ARN string doesn't require the resource to exist.
data "aws_caller_identity" "current" {}

locals {
  opshub_develop_rds_arn = "arn:aws:rds:ap-southeast-1:${data.aws_caller_identity.current.account_id}:db:opshub-develop"
}

resource "aws_iam_role_policy" "deploy_rds_dev_guard" {
  name = "opshub-deploy-develop-rds-guard"
  role = split("/", module.iam_oidc.deploy_role_arns["develop"])[1]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "RDSDevGuard"
        Effect = "Allow"
        Action = [
          "rds:DescribeDBInstances",
          "rds:StartDBInstance",
        ]
        Resource = local.opshub_develop_rds_arn
      }
    ]
  })
}

# NOTE: the former inline patch `deploy_ecs_verify` (ecs:ListTasks on both deploy
# roles) was removed when this stack adopted iam-oidc-v2.0.1 — the module now grants
# ecs:ListTasks on the deploy role, so it is once again the single source of truth.

