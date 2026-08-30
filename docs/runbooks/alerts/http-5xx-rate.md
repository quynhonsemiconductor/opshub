# Alert: http-5xx-rate

Ratio of `http_server_errors_total` to `http_server_requests_total` over 5 minutes has
crossed the environment's threshold (2% prod / 5% develop) for 5 minutes straight.

## What this means

The API is returning 5xx to a meaningful share of real traffic — not a single blip.

## First checks

1. Open the Overview dashboard's "HTTP status code distribution" and "Recent errors"
   panels for this env — is it one route or everything?
2. Check the "Recent errors" / Logs Explorer panel for the actual stack trace. Most
   5xx spikes have one dominant error message.
3. Check the Deploys annotation line on the same dashboard — did this start right after
   a deploy? If so, this is very likely a bad release, not organic load.
4. Check RDS CPU/connections (CloudWatch, per-env dashboard) — a slow query can cascade
   into request timeouts across the whole API. (The dashboard's own "DB pool" panel
   stays dark until `DbPoolMetrics` is wired into `DatabaseModule` — see that panel's
   own comment in `infra/modules/stack/main.tf`.)

## Likely causes, roughly in order

- Bad deploy (see Deploys annotation)
- DB connection exhaustion / a slow query holding connections
- A downstream dependency (SES, Cloudflare, Microsoft Graph) timing out
- Cache (Valkey) unreachable — some paths fail open, others can throw instead

## Escalate if

The error rate keeps climbing after 15 minutes with no obvious cause, or a rollback
of the most recent deploy does not clear it.
