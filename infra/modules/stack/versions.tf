// No `backend` block and no `provider` blocks: a module inherits both from its
// caller. Provider REQUIREMENTS are declared so a caller cannot satisfy this module
// with an incompatible major version.
terraform {
  required_version = ">= 1.9"
  required_providers {
    # `us_east_1` is REQUIRED, not optional: Route 53 publishes health-check metrics only to
    # us-east-1, so the ingress alarm has to be created there even though every other
    # resource in this stack is in ap-southeast-1. Callers pass it explicitly.
    aws        = { source = "hashicorp/aws", version = "~> 5.0", configuration_aliases = [aws.us_east_1] }
    cloudflare = { source = "cloudflare/cloudflare", version = "~> 4.0" }
    # Plain entry, no configuration_aliases, same as cloudflare above: the ROOT
    # configures ONE grafana provider and it inherits down implicitly through this
    # module into observability-alerts — no explicit `providers = {}` passthrough
    # needed at the module "stack" call site.
    grafana = { source = "grafana/grafana", version = "~> 3.0" }
  }
}
