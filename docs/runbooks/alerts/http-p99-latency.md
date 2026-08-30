# Alert: http-p99-latency

p99 of `http_server_duration_milliseconds` has stayed above the environment's
threshold (1000ms prod / 2000ms develop) for 5 minutes straight.

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
- A downstream call with no timeout, or a timeout set too high
- Event loop blocked by synchronous/CPU-heavy work on the request path

## Escalate if

Latency keeps degrading and a specific slow query/operation can't be identified within
20 minutes, or ECS CPU is pinned near 100%.
