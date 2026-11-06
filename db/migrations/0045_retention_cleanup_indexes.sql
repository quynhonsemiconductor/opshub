-- ============================================================================
-- Migration 0045: terminal timestamps + indexes for the nightly retention sweep
-- ============================================================================
-- Retention must count from when a row BECAME terminal (sent/failed/delivered),
-- never from when it was created or scheduled: a row that retried for six weeks
-- before dead-lettering is not 30 days old on the day it fails. The four queues
-- gain `terminal_at`, written by the relays in the same UPDATE as the status.
--
-- Bounced/complained email rows are excluded from deletion entirely: the
-- invitation/email status view reads them and they are the only suppression
-- evidence the product has.
--
-- Plain CREATE INDEX / ADD COLUMN follow the 0039/0044 precedent: drizzle runs
-- one transaction, so CONCURRENTLY is impossible. ADD COLUMN here is nullable
-- with no default (metadata-only), but still takes ACCESS EXCLUSIVE briefly, so
-- lock_timeout makes a blocked migration fail fast instead of queueing requests.
--
-- NO backfill here: drizzle runs this whole file in ONE transaction, so the ADD COLUMN's ACCESS
-- EXCLUSIVE lock would be held until the backfill committed — and a batched LOOP inside that
-- transaction commits nothing. The historical `terminal_at` backfill is the retention WORKER's
-- first phase instead (`RetentionCleanupCron.backfillTerminalAt`), 5k rows per statement,
-- idempotent and safe to rerun.
-- APPLIED ANYWHERE? No: the only application of this file is the author's feature branch; the PR
-- has not merged, so there is no shared database at this tag. It is safe to keep correcting the
-- file in this PR rather than shipping a second migration for a shape nothing has run outside
-- the branch.
--
-- LOCK: plain CREATE INDEX takes SHARE on the table for the build, and drizzle's single
-- transaction cannot run CONCURRENTLY. At today's size (production is two weeks old) the build is
-- short; the 3 s lock_timeout fails fast rather than queueing writers. BEFORE a release on a table
-- that has grown, run the CONCURRENTLY pre-step in docs/runbooks/retention-indexes.md — every
-- index below is IF NOT EXISTS, so the migration then skips it.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
ALTER TABLE messaging.notification_outbox
  ADD COLUMN IF NOT EXISTS terminal_at timestamp with time zone;
--> statement-breakpoint
ALTER TABLE messaging.email_outbox
  ADD COLUMN IF NOT EXISTS terminal_at timestamp with time zone;
--> statement-breakpoint
ALTER TABLE messaging.graph_task_outbox
  ADD COLUMN IF NOT EXISTS terminal_at timestamp with time zone;
--> statement-breakpoint
ALTER TABLE messaging.webhook_deliveries
  ADD COLUMN IF NOT EXISTS terminal_at timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ix_session_expires_at
  ON identity.session (expires_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ix_verification_expires_at
  ON identity.verification (expires_at);
--> statement-breakpoint
-- Partial: only non-pending rows are ever deleted; pending work stays on each relay's own index.
-- The predicate names ONLY 'pending'. The delete query additionally excludes bounced/complained,
-- which is narrower, so the index is still usable. Naming those values here would fail on the
-- legacy upgrade path: they were added to the enum by an earlier migration in the SAME drizzle
-- transaction, and Postgres refuses to use an uncommitted enum value (42704-class error,
-- "unsafe use of new value ... must be committed before they can be used").
CREATE INDEX IF NOT EXISTS ix_notif_outbox_retention
  ON messaging.notification_outbox (terminal_at)
  WHERE status <> 'pending';
--> statement-breakpoint
-- bounced/complained are NEVER purged: the delivery-status view reads them.
CREATE INDEX IF NOT EXISTS ix_email_outbox_retention
  ON messaging.email_outbox (terminal_at)
  WHERE status <> 'pending';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ix_graph_task_retention
  ON messaging.graph_task_outbox (terminal_at)
  WHERE status <> 'pending';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ix_webhook_del_retention
  ON messaging.webhook_deliveries (terminal_at)
  WHERE status <> 'pending';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ix_ian_created_at
  ON notifications.in_app_notifications (created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ix_secure_score_created_at
  ON security_posture.secure_score_snapshots (created_at);
--> statement-breakpoint
RESET lock_timeout;
