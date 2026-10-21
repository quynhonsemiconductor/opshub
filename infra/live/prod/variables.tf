// opshub · production — provider credentials ONLY.
//
// Every stack variable died with the stack (2026-10-21 teardown): an empty
// configuration references nothing else. These three remain because the
// PROVIDERS stay until the destroy is done (refresh + delete need them) —
// see main.tf for which provider needs which, and why they may not be
// removed before the destroy-prod apply has landed.

variable "cloudflare_api_token" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Cloudflare API token (TF_VAR_cloudflare_api_token in CI). Empty skips provider auth — but the destroy of the Pages project, domains, DNS records and tunnels needs it."
}

variable "grafana_alerting_url" {
  type        = string
  default     = "https://qnsc.grafana.net"
  description = "The Grafana instance URL — not a secret."
}

variable "grafana_alerting_auth" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Stack service account token (TF_VAR_grafana_alerting_auth = GRAFANA_ALERTS_TOKEN in CI). The destroy of the dashboards + SLO needs it."
}
