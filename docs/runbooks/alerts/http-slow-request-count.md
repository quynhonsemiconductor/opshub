# Alert: http-slow-request-count

More than 3 HTTP requests took longer than the environment's slow line (1000ms prod /
2500ms develop) in the last 30 minutes.

## Why this exists alongside http-p99-latency

The two alerts watch the same latency and answer different questions, and at low traffic
only this one can answer anything.

`http-p99-latency` computes a percentile, so it needs enough samples for a percentile to
mean something — hence its volume gate, and hence its silence on an environment below
that gate. This rule computes a **count**. A count is valid at any sample size: three
slow requests are three slow requests whether the service handled 5 requests that hour
or 50,000.

So while an environment stays below the p99 rule's gate, **this is the HTTP latency
coverage.** Do not silence it on the grounds that the p99 rule covers the same ground.

## How the query works, and the one way it breaks

Prometheus histogram buckets are cumulative, so the number of requests slower than the
line is the `+Inf` bucket minus the bucket at the line:

```promql
sum(increase(http_server_duration_milliseconds_bucket{le="+Inf",   ...}[30m]))
  - sum(increase(http_server_duration_milliseconds_bucket{le="1000", ...}[30m]))
```

The `le` value is matched as a **string label**, so it must be one of the boundaries the
service actually exports. A plausible-looking number that is not a real boundary — 2000,
1500, 3000 — matches no series at all, the subtraction returns an empty result, and the
rule reports OK forever while looking like coverage.
`terraform_data.slow_request_bucket_is_exported_boundary` in `infra/modules/stack/main.tf`
fails the plan rather than letting that pass review, and it enforces a second rule as
well: the bucket may not sit BELOW the same environment's own p99 threshold, or this rule
would count requests the latency rule considers acceptable and the two would contradict
each other. `local.http_duration_buckets_ms` in the same file is the list of legal
values. That list mirrors `apps/api/src/otel.ts`; if one moves, both move.

## First checks

1. **Find the actual requests.** This alert gives a count, not a duration or a route.
   Logs Explorer for the window, filtered on the API service, sorted by duration.
2. **Check whether they cluster on one route.** A single slow route is a query or a
   downstream call; slow requests spread across every route are the process or the
   database.
3. **Check whether they cluster in time.** Several slow requests inside one minute after
   a deploy or after a scale-from-zero is almost certainly the cold start described
   below, not a regression. Spread evenly across 30 minutes is a real pattern.
4. Runtime & Dependencies dashboard, "DB client operation latency (p99, by operation)"
   and the DB connection panels.
5. Outbound HTTP client calls — a slow Microsoft Graph, SES or S3 call blocks the
   request handling it.

## Likely causes, roughly in order

- **A cold start.** The ALB target group health-checks `/v1/healthz`, which returns 200
  without touching a dependency, so a newly started task is admitted to live traffic
  before its connection pool is warm. Pre-launch this is amplified: `min_count` is 0 in
  production, so the first request after an idle period pays a full task start. The pool
  is now pre-warmed in `DrizzleProvider.onModuleInit` (driven by `DATABASE_POOL_MIN`) —
  if this cause reappears, check whether the warm-up is logging a failure rather than
  succeeding, because it is deliberately non-fatal.
- **A slow query, or one that used to be fast on a smaller table.**
- **RDS CPU credit exhaustion.** Production runs `db.t4g.micro`, which is burstable and
  degrades into throttling rather than failing. `<name>-rds-cpu-credit-low` alarms on
  this directly; check it for the same window.
- **A downstream call with a large timeout budget.** Note these requests usually
  **succeed**, so the 5xx rate alert will not corroborate. Read the `maxAttempts` note in
  `ResilienceService` before estimating a budget: it counts RETRIES, so `external` is
  four calls of up to 10s each plus backoff, a worst case near 41s. Interactive request
  paths should be on the `interactive` preset, which bounds at ~6.2s.
- Event loop blocked by synchronous or CPU-heavy work on the request path.

## Escalate if

The count keeps climbing across consecutive windows, or the slow requests cannot be
attributed to a route or a dependency within 20 minutes. A sustained count is the early
form of the outage `http-5xx-rate` would report later.
