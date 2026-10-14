# Alert: outbox-relay-failing

An outbox relay's **pass** has thrown continuously for 10 minutes. `outbox_relay_pass_failed_total{relay}` increased in
every 3-minute window for 10 minutes (relays pass every 5 to 10 seconds, so a healthy relay adds nothing).

## What this means

A pass dies **before it reaches a single row**: its claim query failed (a SQL error, a lost or exhausted database
connection, a schema change the query does not match). Nothing is delivered for that relay, and nothing else reports it:

- `queue_failures_total` counts ROWS that failed to deliver, and is recorded only after the claim;
- `outboxDeadLetter` (the CloudWatch alarm) needs a row to have been claimed;
- `worker-job-failure-rate` reads `job_*` metrics, and relays are not timed by them.

The relay is named by the `relay` label: `WebhookRelayService`, `EmailRelayService`, `NotificationRelayService`,
`GraphAccountRelayService` or `GraphScanRelayService`.

History: `WebhookRelayService` failed every pass for weeks with `FOR UPDATE must specify unqualified relation names`
(Drizzle rendered `FOR UPDATE OF "messaging"."webhook_deliveries"` for a table in a `pgSchema`), so no outgoing webhook
was ever delivered, and nothing alerted.

## First checks

1. Which relay: Grafana Explore, `sum by (relay) (increase(outbox_relay_pass_failed_total{deployment_environment_name="<env>"}[10m]))`.
2. The error, in Loki:
   `{service_name="opshub-worker", deployment_environment_name="<env>"} |= "<RelayClassName>" | detected_level="error"`
   The exception text names the cause (a Postgres error code, `ECONNREFUSED`, `too many clients`).
3. Is it all relays or one? All of them: the database or its pool (RDS stopped, a failover, the `db-pool-contention` alert).
   One: that relay's own claim query, usually after a deploy or a migration.
4. Did it start with a deploy? The Deploys annotation on the overview dashboard.

## After a long outage: the backlog

When the cause is fixed the relay claims everything that waited, at once: up to 50 batches of 5 per pass, one delivery
at a time, each request with a 10-second timeout. Before the first pass after a long outage, look at what is waiting:

```sql
-- how much is waiting, and how old
SELECT status, count(*) AS rows, min(created_at) AS oldest, max(created_at) AS newest,
       max(attempts) AS max_attempts
FROM messaging.webhook_deliveries
GROUP BY status ORDER BY status;

-- who would be flooded
SELECT s.url, count(*) AS pending, min(d.created_at) AS oldest
FROM messaging.webhook_deliveries d
JOIN messaging.webhook_subscriptions s ON s.id = d.subscription_id
WHERE d.status = 'pending'
GROUP BY s.url ORDER BY pending DESC;
```

Replace `webhook_deliveries` with `email_outbox` / `notification_outbox` for the other relays (the columns differ; start
from `status`, `created_at`, `attempts`).

A delivery carries its own `id` and `eventType`, but the body's `timestamp` is the moment of SENDING. A receiver cannot
tell a three-week-old event from a fresh one. If the oldest rows are stale enough that delivering them is worse than
dropping them, mark them failed BEFORE the relay can claim them (stop the worker, or do it in the same minute the fix
deploys):

```sql
UPDATE messaging.webhook_deliveries
SET status = 'failed', last_error = 'expired undelivered: the relay was failing; not sent'
WHERE status = 'pending' AND created_at < now() - interval '24 hours';
```

The cut-off is a decision for whoever owns the subscribers, not a default.

## Escalate if

More than one relay is failing, or the error is a database connection error: that is the database, not a relay.
