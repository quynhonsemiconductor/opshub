-- Asynchronous email feedback: bounce and complaint events land on the rows that sent them.
--
-- "Sent" in email_outbox has always meant ACCEPTED BY THE PROVIDER. SES answers 200 before the
-- receiving mail server has said a single word, so a hard-bounced address and a delivered one
-- were indistinguishable in the data — and the one user-visible symptom of the difference was
-- silence: an invitation the inviter saw as sent, the invitee never saw at all. That exact
-- case cost a multi-day investigation (accepted by SES, quarantined by the receiving tenant,
-- every local signal green), and the honest conclusion was that "accepted" must stop being the
-- last thing we know.
--
-- This migration is the storage half of the feedback loop; the worker half is
-- BounceFeedbackService, and the AWS half is a configuration set whose bounce/complaint events
-- fan out SNS -> SQS -> that consumer. Three pieces of state:
--
--   * two new enum values, `bounced` and `complained`, written ONLY by the feedback consumer.
--     They overlay a row that is already `sent` — the send happened; this is what came back —
--     so the relay's own writes never set them and nothing resets a row to `sent` afterwards.
--     ALTER TYPE ... ADD VALUE is idempotent-guarded because a value, once added, cannot be
--     re-added on a database that already ran this file.
--   * `message_id`: the provider's id, stored by the relay at acceptance. SES echoes it as
--     `mail.messageId` in every event notification, which makes the match exact rather than
--     heuristic (address + time would misattribute a re-invite to the earlier attempt).
--   * `feedback_at`: when the verdict arrived, for telling a fresh bounce from a stale one.
--
-- Existing rows get NULL for both new columns and stay exactly as they are: their sends
-- predate the loop and no verdict will ever arrive for them, which `NULL` states honestly.

ALTER TYPE outbox_status ADD VALUE IF NOT EXISTS 'bounced';
ALTER TYPE outbox_status ADD VALUE IF NOT EXISTS 'complained';

ALTER TABLE messaging.email_outbox
  ADD COLUMN IF NOT EXISTS message_id varchar(255),
  ADD COLUMN IF NOT EXISTS feedback_at timestamptz;

CREATE INDEX IF NOT EXISTS ix_email_outbox_message_id
  ON messaging.email_outbox (message_id)
  WHERE message_id IS NOT NULL;
