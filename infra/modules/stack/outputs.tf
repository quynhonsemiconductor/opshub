// Re-exported by each live caller, so CI's output-sync (which reads ECS/RDS/
// networking names from the stack outputs) keeps working unchanged.
output "alb_dns_name" { value = try(data.terraform_remote_state.runtime.outputs.alb_dns_name, null) }
output "ecs_cluster_name" { value = module.ecs_cluster.cluster_name }
output "ecs_api_service" { value = module.api.service_name }
output "ecs_worker_service" { value = module.worker.service_name }
output "ecs_migrator_task_def" {
  value       = module.migrator.family
  description = "Migrator task definition family name — use with aws ecs run-task"
}
output "rds_endpoint" { value = module.rds.endpoint }
output "rds_master_secret_arn" { value = module.rds.master_secret_arn }
# Null when the cache is disabled for an idled environment, rather than a plan error.
output "cache_endpoint" { value = var.cache.enabled ? module.cache[0].endpoint : null }
output "secret_arns" { value = module.secrets.secret_arns }

# Networking — needed for ECS run-task (migrator) and the GitHub environment vars.
# Sourced from the shared runtime layer so the CI output-sync stays correct.
output "private_subnet_ids" { value = data.terraform_remote_state.runtime.outputs.private_subnet_ids }
output "sg_app_id" { value = data.terraform_remote_state.runtime.outputs.sg_app_id }

# Web (Cloudflare Pages) — PAGES_PROJECT is published to the GitHub environment vars
# for web-deploy.yml (wrangler --project-name).
output "web_pages_project" { value = try(module.web[0].project_name, null) }
output "web_custom_domain" { value = try(module.web[0].custom_domain, null) }
output "web_url" { value = try("https://${module.web[0].custom_domain}", null) }
