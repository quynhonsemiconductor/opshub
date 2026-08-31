# Alert: http-p99-latency

p99 of `http_server_duration_milliseconds` has stayed above the environment's
threshold (1000ms prod / 2000ms develop) for 5 minutes straight, in a 5-minute window
that held at least the environment's minimum request count (50 prod / 20 develop).

## Read the number before you act on it

Two things about this alert's value are not obvious from the notification, and both have
already sent someone down the wrong path on the sibling product:

- **A value of exactly the top bucket boundary is not a latency measurement.**
  `histogram_quantile` cannot report anything above the largest finite bucket, so it
  clamps there. When the boundaries ended at 10000, a page reading `A=10000` meant only
  "at least one request took longer than 10 seconds, and the histogram cannot say how
  much longer" — the real value could have been 11 seconds or 4 minutes. The view is now
  widened to 60000 (`apps/api/src/otel.ts`, mirrored by
  `local.http_duration_buckets_ms`), so the resolution is better, but the clamp is a
  property of the TOP bucket rather than of any particular number and still applies
  there. To find an actual duration, go to the traces or the request log for the window,
  not to this metric. And do not read a drop from the top bucket to a two-digit number as
  a large improvement: it usually just means the slow request aged out of the window.
- **This rule is volume-gated, so silence is not the same as health.** The query only
  evaluates when the 5-minute window holds at least 50 requests in production or 20 in
  develop. Below that floor the rule reports no data, which Grafana renders as OK. That
  state means "not enough samples to compute a percentile", NOT "latency is fine".

  The gate exists because a percentile over a handful of samples is not a percentile. A
  5-minute window holding one real request makes the p99 of that window equal to that one
  request, and the alert then fires and clears on individual requests. The same defect
  was found and fixed on the CloudWatch side first — see the `alb_latency` alarm in
  `qnsc-tf-modules//modules/observability`, which gained the identical gate at the same
  floor of 50.

  The coverage that survives below the gate is **`http-slow-request-count`**, which counts
  requests over the slow line instead of computing a percentile of them. If you want to
  know whether the service is slow at low traffic, that is the alert to look at; this one
  cannot tell you.

## What this means

The slowest 1% of requests are slow enough to matter — this fires independent of the
error rate, so the request usually still succeeds, just late.

## First checks

1. Overview dashboard, "HTTP p50/p95/p99 latency" — is it all three percentiles moving,
   or just p99 (a few genuinely slow requests vs the whole service degrading)?
2. Runtime & Dependencies dashboard, "DB client operation latency (p99, by operation)" —
   a slow SELECT/INSERT/UPDATE is the most common root cause.
3. "Outbound HTTP client calls: rate + p99 latency" — a slow downstream (SES, Microsoft
   Graph, Cloudflare) blocks the request handling it.
4. "Node.js event loop lag" — if this is elevated, the process itself is CPU-starved,
   not waiting on I/O; check ECS CPU (CloudWatch) for the same window.

## Likely causes, roughly in order

- A missing index or a query that used to be fast on a smaller table
- **A cold start.** The ALB target group health-checks `/v1/healthz`, which returns 200
  without touching a dependency, so a newly started task is admitted to live traffic
  before its connection pool is warm. Pre-launch `min_count` is 0 in production, so the
  first request after an idle period pays a full task start. The pool is pre-warmed in
  `DrizzleProvider.onModuleInit` (driven by `DATABASE_POOL_MIN`) — if this cause appears,
  check whether the warm-up logged a failure, because it is deliberately non-fatal.
- **RDS CPU credit exhaustion.** Production runs `db.t4g.micro`, which is burstable and
  degrades into throttling rather than failing. `<name>-rds-cpu-credit-low` alarms on it
  directly; check that alarm for the same window.
- A downstream call with no timeout, or a timeout set too high. Read the `maxAttempts`
  note in `ResilienceService` before estimating a budget: it counts RETRIES, so `external`
  is four calls of up to 10s each plus backoff, a worst case near 41s. A request path
  should be on the `interactive` preset, which bounds at ~6.2s.
- Event loop blocked by synchronous/CPU-heavy work on the request path

## Escalate if

Latency keeps degrading and a specific slow query/operation can't be identified within
20 minutes, or ECS CPU is pinned near 100%.
