variable "cloudflare_api_token" {
  type        = string
  sensitive   = true
  default     = ""
  description = <<-EOT
    Cloudflare API token (Zone:DNS:Edit + Pages:Edit on qnsc.vn). Supplied via
    TF_VAR_cloudflare_api_token in CI. Leave empty to skip Cloudflare provider auth.
    The zone ID itself is NOT an input here — it is read from the qnsc-infra bootstrap
    via _shared remote state (one source of truth, like kms_key_arn).
  EOT
}

// ── Public identifiers, held in git on purpose ────────────────────────────────
// These are NOT secrets: an Entra tenant/client id appears in the browser's auth
// redirect, and a Cloudflare account id identifies the account without authorising
// anything. The corresponding SECRETS live in Secrets Manager (graph-client-secret)
// and the Cloudflare API token stays a GitHub secret.
//
// They used to arrive as TF_VARs from GitHub Actions variables and secrets, which made
// `Infrastructure · Plan` lie. ENTRA_CLIENT_ID is environment-scoped and the plan job
// has no `environment:` context (adding one would gate every PR behind the production
// reviewer), so it resolved to "" while the apply saw the real value — and every plan
// reported the api and worker task definitions "must be replaced". Reviewers who see
// phantom replacements on every PR stop reading plans, which is exactly when a real one
// slips through.
//
// ENTRA_TENANT_ID was never affected: it is an ORG-level variable, visible to both jobs.
// The value here is the same one — verified against the running task definition — so
// holding it in git changes nothing except that it is now reviewable in a diff.
// CLOUDFLARE_ACCOUNT_ID is an org variable too, which is the actual reason module.web
// has never been created: the workflows read `secrets.CLOUDFLARE_ACCOUNT_ID`, and a
// variable is not a secret, so the count-gate always saw "".
//
// In git the value is identical at plan and apply time, so the plan tells the truth and
// the value is reviewable in a diff. Same treatment as rally.

variable "entra_tenant_id" {
  description = "Microsoft Entra tenant id for QNSC (public) — the same directory rally authenticates against."
  type        = string
  default     = "dc0f2078-ac28-4ff2-b21a-d4b28df32361"
}

variable "entra_client_id" {
  description = "Entra application (client) id for opshub develop — a distinct app registration per environment."
  type        = string
  default     = "5a83d82b-34ed-4701-b426-635fd303d875"
}

variable "cloudflare_account_id" {
  description = <<-EOT
    Cloudflare account that owns the Pages project (also a public identifier — it names
    an account without authorising anything).

    It was empty until now, and the reason is worth keeping: it used to be plumbed from
    `secrets.CLOUDFLARE_ACCOUNT_ID`, but it is an org-level VARIABLE, not a secret. A
    `secrets.` reference to a variable evaluates to empty with no error, so the
    count-gated `module.web` resolved to 0 on every apply and the SPA was never managed
    by Terraform at all.

    A stray `opshub-develop-web` Pages project existed in a DIFFERENT Cloudflare
    account, deployed by hand — `opshub-develop-web.pages.dev` served the SPA while both
    wrangler and Terraform reported "project does not exist" against this account. It was
    deleted rather than imported, so opshub and rally keep one account, one API token and
    one zone; Terraform creates the project here instead.
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
