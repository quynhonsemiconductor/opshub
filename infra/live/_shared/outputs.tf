output "ecr_repository_urls" { value = module.ecr.repository_urls }

# Per-environment app deploy role ARNs — update GitHub Actions secrets when these change.
# develop:    OPSHUB_DEPLOY_ROLE_ARN (in the "develop" environment)
# production: OPSHUB_DEPLOY_ROLE_ARN (in the "production" environment)
output "deploy_role_arns" {
  value       = module.iam_oidc.deploy_role_arns
  description = "Map of env → deploy role ARN. Update GitHub Actions environment secrets."
}

output "ecr_push_role_arn" { value = module.iam_oidc.ecr_push_role_arn }
output "infra_plan_role_arn" { value = module.iam_oidc.infra_plan_role_arn }
output "infra_apply_role_arn" { value = module.iam_oidc.infra_apply_role_arn }

# ── Re-exported from qnsc-infra platform layer ────────────────────────────────
output "kms_key_arn" {
  value       = data.terraform_remote_state.platform.outputs.kms_key_arn
  description = "Shared CMK ARN from qnsc-infra — pass to RDS and Secrets modules"
}

output "artifacts_bucket_name" {
  value       = data.terraform_remote_state.platform.outputs.artifacts_bucket_name
  description = "Shared artifacts bucket from qnsc-infra — use in publish-openapi-spec CI"
}

# From a REQUIRED, validated variable (var.cloudflare_zone_id), not from the platform's remote state: that
# read went through try(..., "") and exported "" when the platform output was empty, which made the env
# stacks plan the destruction of their DNS records. Never empty here: the variable's validation stops the
# plan, and the precondition below is the same check on the value that is actually exported.
output "cloudflare_zone_id" {
  value       = var.cloudflare_zone_id
  description = "Cloudflare Zone ID for qnsc.vn — env stacks pass it to the dns-record and pages-web modules. Never empty."

  precondition {
    condition     = can(regex("^[0-9a-f]{32}$", var.cloudflare_zone_id))
    error_message = "Refusing to export an empty or malformed cloudflare_zone_id: every env stack that reads it would replace its DNS records."
  }
}
output "cloudflare_ipv4" {
  value       = try(data.terraform_remote_state.platform.outputs.cloudflare_ipv4, [])
  description = "Cloudflare IPv4 ranges from qnsc-infra — prod stacks use for ALB ingress allow-list"
}
