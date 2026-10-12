variable "github_org" {
  type        = string
  description = "GitHub organisation or username that owns opshub-api, opshub-web, opshub-infra repos"
  default     = "quynhonsemiconductor"
}

variable "cloudflare_zone_id" {
  type = string
  # NO DEFAULT, deliberately. This used to be read from the platform's remote state through
  # try(..., ""), so a platform apply that wrote "" made this stack export "", and the next
  # develop/prod apply planned to DESTROY the API and web DNS records and the Pages domain
  # (develop, 2026-10-12; the same cause destroyed live/edge's records on 2026-10-09). A missing
  # value must stop the plan, not become an empty string that every consumer turns into resource identity.
  description = <<-EOT
    Cloudflare zone id of qnsc.vn: 32 lower-case hex characters. CI passes it as
    TF_VAR_cloudflare_zone_id from the CLOUDFLARE_ZONE_ID organisation variable (visible to the plan
    and apply jobs alike); for a local run pass the same value (Cloudflare dashboard > qnsc.vn >
    Overview > API). Not sensitive. Re-exported to the env stacks as the `cloudflare_zone_id` output.
  EOT

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.cloudflare_zone_id))
    error_message = "cloudflare_zone_id must be the 32-hex-character Cloudflare zone id of qnsc.vn (CI: the CLOUDFLARE_ZONE_ID organisation variable). An empty or malformed value would make the env stacks destroy their DNS records."
  }
}
