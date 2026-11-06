# Retention indexes: CONCURRENTLY pre-step

Migration `0045_retention_cleanup_indexes.sql` creates the retention indexes inside drizzle's
single migration transaction, so it **cannot** use `CONCURRENTLY`. At today's table sizes that is
fine (the build is short and `lock_timeout = '3s'` fails fast instead of queueing writers). On a
table that has grown, a plain `CREATE INDEX` takes SHARE and blocks INSERT/UPDATE/DELETE for the
whole build.

Before releasing 0045 to an environment where any of these tables is large, connect as the
migration role and run the matching statements **by hand, one at a time** (autocommit; each must
finish before the migration runs). Every index below is `IF NOT EXISTS`, so the migration then
skips it.

```sql
-- The terminal_at indexes below cannot be built before 0045 ADDS the column. Add it first, on
-- each of the four queues. Nullable with no default = metadata-only; the short lock_timeout keeps
-- the ACCESS EXCLUSIVE window to an instant. 0045's ADD COLUMN is IF NOT EXISTS, so it then
-- no-ops on both halves.
SET lock_timeout = '3s';
ALTER TABLE messaging.notification_outbox ADD COLUMN IF NOT EXISTS terminal_at timestamptz;
ALTER TABLE messaging.email_outbox         ADD COLUMN IF NOT EXISTS terminal_at timestamptz;
ALTER TABLE messaging.graph_task_outbox    ADD COLUMN IF NOT EXISTS terminal_at timestamptz;
ALTER TABLE messaging.webhook_deliveries   ADD COLUMN IF NOT EXISTS terminal_at timestamptz;
RESET lock_timeout;

CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_session_expires_at
  ON identity.session (expires_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_verification_expires_at
  ON identity.verification (expires_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_notif_outbox_retention
  ON messaging.notification_outbox (terminal_at)
  WHERE status <> 'pending';

CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_email_outbox_retention
  ON messaging.email_outbox (terminal_at)
  WHERE status <> 'pending';

CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_graph_task_retention
  ON messaging.graph_task_outbox (terminal_at)
  WHERE status <> 'pending';

CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_webhook_del_retention
  ON messaging.webhook_deliveries (terminal_at)
  WHERE status <> 'pending';

CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_ian_created_at
  ON notifications.in_app_notifications (created_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_secure_score_created_at
  ON security_posture.secure_score_snapshots (created_at);
```

Check for an INVALID index before proceeding:

```sql
SELECT indexrelid::regclass, indisvalid
FROM pg_index
WHERE NOT indisvalid;
```

A failed CONCURRENTLY build leaves an invalid index; drop it with `DROP INDEX CONCURRENTLY IF
EXISTS <name>` and rerun. Do not let 0045 run while an invalid index of the same name exists —
`IF NOT EXISTS` would skip it.

After the pre-step, 0045 still runs: its `ADD COLUMN IF NOT EXISTS` and every
`CREATE INDEX IF NOT EXISTS` are no-ops for what you just built, and it still creates anything you
did not pre-build.

The `terminal_at` backfill is NOT part of 0045; it is the worker's retention first phase
(`RetentionCleanupCron.backfillTerminalAt`), 5k rows per committed statement and safe to rerun.
