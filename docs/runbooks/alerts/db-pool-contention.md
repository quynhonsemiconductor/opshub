# Alert: db-pool-contention

`db_pool_waiting` is above 0 for 5 minutes straight — connections are queueing for the
app's own DB connection pool (this is the pool inside the Node process, not RDS's own
connection count).

## Currently dark

This alert cannot fire yet: `db_pool_in_use`/`db_pool_waiting` are only emitted by
`@qnsc-vn/observability`'s `DbPoolMetrics` recorder, and opshub's `DatabaseModule` does
not call it. It stays in this alert set and on the Overview dashboard for structural
parity with rally — wiring `DbPoolMetrics` into `libs/platform/src/database` is a
separate, application-code follow-up. Until then, treat RDS "DatabaseConnections"
(CloudWatch) as the only pool-pressure signal available.

## What this means, once wired

The app is asking for more DB connections at once than the pool is configured to hand
out. Either the pool is undersized, or something is holding connections too long
(a slow query, a transaction that never commits/rolls back, a leak).

## First checks

1. Runtime & Dependencies dashboard, "DB client connections: by state, vs pending" —
   confirm which service (opshub-api / opshub-worker) is pending, and how many.
2. "DB client operation latency (p99, by operation)" on the same dashboard — a spike in
   one operation's latency (commonly a long-running query) is the usual root cause; that
   query is holding a connection for the whole time it runs.
3. Check RDS "DatabaseConnections" (CloudWatch) — is the app pool actually starved, or
   is RDS itself near its max_connections limit (something else consuming connections)?
4. Check for a recent deploy or code change that added a new query path, especially one
   inside a loop or without a `LIMIT`.

## Likely causes, roughly in order

- A slow query (missing index, N+1, unbounded result set) holding a connection for a
  long time under load
- A transaction not being committed/rolled back promptly (a bug, or an exception path
  that skips cleanup)
- Pool size genuinely too small for current traffic — check if this correlates with a
  traffic increase rather than a specific bad query
- A recent migration/deploy introducing a new hot query path

## Escalate if

Waiting connections keep growing rather than draining, or `http-5xx-rate` /
`http-p99-latency` fire alongside this one — that combination usually means requests
are timing out waiting for a connection that will never free up on its own, and a
service restart may be needed to clear stuck connections while the root cause is found.
