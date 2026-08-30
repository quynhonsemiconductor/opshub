variable "image_tag" {
  type        = string
  default     = "latest"
  description = <<-EOT
    Container image tag for api/worker/migrator. infra-apply.yml overrides this with
    the v*.*.* tag that triggered the apply, so production runs exactly the release it
    belongs to.

    The default exists so `tofu plan` works without it — the plan job deliberately does
    not pass a tag (it is only known at release time), and a required variable with no
    default would make every prod plan fail instead of merely showing a task-definition
    revision bump.
  EOT
}

variable "cloudflare_api_token" {
  type        = string
  sensitive   = true
  default     = ""
  description = <<-EOT
    Cloudflare API token (Zone:DNS:Edit + Pages:Edit on qnsc.vn). Supplied via
    TF_VAR_cloudflare_api_token in CI. Leave empty to skip Cloudflare provider auth.
    The zone ID itself is NOT an input here — it is read from the qnsc-infra bootstrap
    via _shared remote state.
  EOT
}

// ── Public identifiers, held in git on purpose ────────────────────────────────
// See ../develop/variables.tf for why these are values in git rather than TF_VARs
// from Actions variables: environment-scoped variables are invisible to the plan job,
// so passing them that way made every plan report phantom task-definition
// replacements.

variable "entra_tenant_id" {
  description = "Microsoft Entra tenant id for QNSC (public) — the same directory rally authenticates against."
  type        = string
  default     = "dc0f2078-ac28-4ff2-b21a-d4b28df32361"
}

variable "entra_client_id" {
  description = <<-EOT
    Entra application (client) id for opshub PRODUCTION.

    Empty because the production app registration does not exist yet — develop and
    production need separate registrations (different redirect URIs), and only
    develop's has been created. ENTRA_CLIENT_ID is optional in the API's env schema, so
    the tasks still boot and the Entra-dependent features report themselves disabled.

    GO-LIVE: create the production app registration and put its client id here. Empty
    means nobody can sign in.
  EOT
  type        = string
  default     = ""
}

variable "cloudflare_account_id" {
  description = <<-EOT
    Cloudflare account that owns the Pages project (public identifier).

    No `import` block here, unlike develop: `opshub-prod-web` does not exist yet
    (`opshub-prod-web.pages.dev` does not resolve), so the first prod apply creates the
    project, its custom domain and the CNAME cleanly.
  EOT
  type        = string
  default     = "69e52835cf2d08edde5b6ebd741d30fa"
}

variable "otlp_endpoint" {
  description = <<-EOT
    OTLP/HTTP base URL of the telemetry backend — qnsc-infra's live/observability
    stack, region prod-ap-southeast-0 (the SAME shared Grafana Cloud stack rally
    already pushes to — one stack, every product, tenancy is the
    product/environment resource attributes each sidecar sets), with the `/otlp`
    suffix the otlphttp exporter needs.

    Setting this creates the `observability-token` Secrets Manager secret (empty)
    and flips the sidecar on in the task definition — but the secret's VALUE must
    be populated by hand (Basic base64(stack_id:token), the SAME shared
    write-only otlp-sidecar-push token rally uses, never through Terraform — see
    modules/stack/main.tf) and the service must be DEPLOYED before telemetry
    actually flows.
  EOT
  type        = string
  default     = "https://otlp-gateway-prod-ap-southeast-0.grafana.net/otlp"
}

variable "grafana_alerting_url" {
  description = "The Grafana instance URL — qnsc-infra's live/observability stack's `alerting_grafana_url` output. Same value in every environment; not a secret."
  type        = string
  default     = "https://qnsc.grafana.net"
}

variable "grafana_alerting_auth" {
  description = <<-EOT
    Stack service account token — qnsc-infra's live/observability stack's
    `alerting_service_account_token` output. Reaches Terraform via
    TF_VAR_grafana_alerting_auth in CI (GRAFANA_ALERTS_TOKEN secret), NEVER
    through AWS Secrets Manager — see modules/stack/variables.tf's
    grafana_alerting_auth for why. Blank keeps Grafana Alerting dormant
    (module.alerts is count-gated to zero); CloudWatch Alarms are unaffected
    either way.
  EOT
  type        = string
  sensitive   = true
  default     = ""
}

variable "grafana_alerting_prometheus_datasource_name" {
  description = "qnsc-infra's live/observability stack's `alerting_prometheus_datasource_name` output. Same value in every environment; not a secret."
  type        = string
  default     = "grafanacloud-qnsc-prom"
}

variable "grafana_logs_datasource_name" {
  description = "Grafana Cloud's auto-provisioned Loki datasource name for this stack, same as rally's. Same value in every environment; not a secret."
  type        = string
  default     = "grafanacloud-qnsc-logs"
}

variable "grafana_alerting_folder_uid" {
  description = <<-EOT
    qnsc-infra's live/observability stack's `alerting_folder_uid` output — the
    shared folder every product's rule groups live under, rally's included.
    Same value in every environment and every product; not a secret. See
    rally's own copy of this variable for the destroy+recreate fragility of
    hardcoding a Grafana folder UID — a `terraform_remote_state` read would
    self-heal instead of silently going stale.
  EOT
  type        = string
  default     = "efwpy0l5x8nwgb"
}

variable "grafana_dashboards_folder_uid" {
  description = "qnsc-infra's live/observability stack's `dashboards_folder_uid` output — the PARENT folder every product's own dashboard subfolder nests under. Unused directly here (opshub's dashboards nest under grafana_opshub_dashboards_folder_uid below), kept for parity with rally's own copy of this variable."
  type        = string
  default     = ""
}

variable "grafana_opshub_dashboards_folder_uid" {
  description = <<-EOT
    qnsc-infra's live/observability stack's `opshub_dashboards_folder_uid`
    output — opshub's own dashboard SUBFOLDER, created once, centrally (see
    qnsc-infra PR #105 and rally's own duplicate-folder incident for why it
    is not a `grafana_folder` resource inside this stack module instead).
  EOT
  type        = string
  default     = "cfwqtc9gtooowd"
}

variable "grafana_slos_folder_uid" {
  description = "qnsc-infra's live/observability stack's `slos_folder_uid` output — the shared folder every product's SLOs live under. Same value in every environment and every product; not a secret."
  type        = string
  default     = "ffwpy0lokzcw0e"
}

variable "alarm_emails" {
  description = <<-EOT
    Addresses subscribed to this environment's alarm topic. Terraform creates the
    subscription; each recipient must still confirm it by email, so an unconfirmed address
    silently receives nothing.

    Empty means the alarms still exist and still change state — they just page nobody.
  EOT
  type        = list(string)
  default     = []
}
