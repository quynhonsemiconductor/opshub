-- ============================================================================
-- Migration 0045: indexes for the nightly app-table retention sweep
-- ============================================================================
-- RetentionCleanupCron deletes in bounded batches ordered by the retention
-- column. Without these indexes each batch scans the whole table, which is
-- worst exactly when a backlog has built up. Plain CREATE INDEX follows the
-- 0039/0044 precedent: drizzle runs one transaction, so CONCURRENTLY cannot.
--
-- Partial indexes on terminal outbox rows keep them proportional to the
-- DELETABLE set — pending work is never indexed here and is already covered by
-- each relay's own (status, due) index.
-- ============================================================================

CREATE INDEX IF NOT EXISTS ix_session_expires_at
  ON identity.session (expires_at);

CREATE INDEX IF NOT EXISTS ix_verification_expires_at
  ON identity.verification (expires_at);

CREATE INDEX IF NOT EXISTS ix_notif_outbox_retention
  ON messaging.notification_outbox (scheduled_at)
  WHERE status <> 'pending';

CREATE INDEX IF NOT EXISTS ix_email_outbox_retention
  ON messaging.email_outbox (coalesce(sent_at, scheduled_at))
  WHERE status <> 'pending';

CREATE INDEX IF NOT EXISTS ix_graph_task_retention
  ON messaging.graph_task_outbox (created_at)
  WHERE status <> 'pending';

CREATE INDEX IF NOT EXISTS ix_webhook_del_retention
  ON messaging.webhook_deliveries (created_at)
  WHERE status <> 'pending';

CREATE INDEX IF NOT EXISTS ix_ian_created_at
  ON notifications.in_app_notifications (created_at);

CREATE INDEX IF NOT EXISTS ix_secure_score_created_at
  ON security_posture.secure_score_snapshots (created_at);
