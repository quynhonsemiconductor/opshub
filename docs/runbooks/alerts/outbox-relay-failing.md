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

## After a long outage: the backlog clears itself

Nothing is replayed that is too old, and nothing is done by hand. The webhook relay **expires** a delivery that has been
`pending` longer than `WEBHOOK_DELIVERY_MAX_AGE_HOURS` (default **24**, whole hours, worker and API config):

- It happens in the relay's own claim transaction, before it selects what is due. The candidate rows are locked
  `FOR UPDATE SKIP LOCKED` (a row another transaction holds is skipped, not waited for), and a row with a **live lease**
  is not a candidate (a relay is delivering it). The update clears `lease_token`, so a relay whose lease had lapsed and
  that is still running cannot write `delivered` over `failed`: its fence no longer matches. An expired row is no longer
  `pending`, so no relay can claim it.
- The row is marked `failed` with `last_error = 'expired: pending longer than <N> h'`, spends no attempt, and is
  **kept** (never deleted). It is never fetched. Age is measured from `created_at`.
- It is counted: `outbox_relay_expired_total{relay}`, and logged at `warn` ("Expired N webhook deliver(ies) pending
  longer than N h; not sent"). It does not trip the `outboxDeadLetter` alarm: expiry is the policy, not lost work.
- A delivery younger than the maximum age is sent as usual, so after an outage shorter than a day the backlog is
  delivered; after a longer one only the last day is.

So when the cause is fixed and the relay recovers, rows older than the limit are expired on its first pass, and the rest
are delivered: up to 50 batches of 5 per pass, one request at a time (10 s timeout each), per subscriber URL.

### Find expired rows

```sql
-- how many, per subscriber, and how old
SELECT s.url, count(*) AS expired, min(d.created_at) AS oldest, max(d.created_at) AS newest
FROM messaging.webhook_deliveries d
JOIN messaging.webhook_subscriptions s ON s.id = d.subscription_id
WHERE d.status = 'failed' AND d.last_error LIKE 'expired:%'
GROUP BY s.url ORDER BY expired DESC;

-- one subscriber's, newest first
SELECT id, event_type, created_at, last_error
FROM messaging.webhook_deliveries
WHERE status = 'failed' AND last_error LIKE 'expired:%' AND subscription_id = '<subscription id>'
ORDER BY created_at DESC LIMIT 50;
```

The same view of the whole queue: `SELECT status, count(*), min(created_at), max(created_at) FROM
messaging.webhook_deliveries GROUP BY status`. (`email_outbox` / `notification_outbox` are not expired: only webhooks
carry a body whose age a receiver cannot see.)

### Re-queue one deliberately

Only if a specific event must still go out. Re-queue **by id**, and reset `created_at`: the age limit is measured from
it, so a row put back as `pending` with its old `created_at` is expired again on the next claim.

```sql
BEGIN;
UPDATE messaging.webhook_deliveries
SET status = 'pending', attempts = 0, last_error = NULL,
    next_attempt_at = now(), created_at = now()
WHERE id = '<delivery id>'
  AND status = 'failed' AND last_error LIKE 'expired:%' AND lease_token IS NULL;
-- must say UPDATE 1 (a different count means the id was wrong or the row is not an expired one): ROLLBACK if not.
COMMIT;
```

No worker stop is needed: a `failed` row with no lease is not claimed by any relay, and nothing else writes it.
The receiver will get the event with the **time of sending** in `timestamp` (the original `id` and `eventType` are
kept), which is the reason these rows were not sent in the first place.

To change the limit: set `WEBHOOK_DELIVERY_MAX_AGE_HOURS` on the worker (and the API, which validates the same schema)
and redeploy. It applies to rows already `pending`.

## Escalate if

More than one relay is failing, or the error is a database connection error: that is the database, not a relay.
