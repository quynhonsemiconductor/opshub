-- Graph work moves out of API requests, and every outbox relay stops holding a transaction across its
-- external call.
--
-- 1. LEASE-AND-FENCE columns on all four outbox tables: seq (claim order), lease_token (who holds the
--    row), locked_until (when the hold lapses). A relay claims rows in a short transaction, calls out
--    with NO transaction open, and finishes in a new one fenced on lease_token. Before this a relay kept
--    one transaction and its row locks open across the call; a long call outlived the role's
--    idle_in_transaction_session_timeout, the session died, the batch AND its attempt counters rolled
--    back, and the row never dead-lettered.
-- 2. messaging.graph_task_outbox: Graph work the API requests and only the worker performs.
-- 3. messaging.graph_sync_state: where the Intune device sync resumes.
-- 4. compliance_findings.source 60 -> 255: `intune:<uuid>:noncompliant,unencrypted` is 70+ characters,
--    so the insert failed with 22001 and, inside the old shared transaction, aborted the whole pass.
--
-- 5. identity.employees: a case-insensitive unique index on the email. The Graph worker and identity v8
--    both compare addresses lower-cased; `Ada@x` and `ada@x` must not be two employees. A preflight
--    refuses the migration, naming the addresses, if any two rows already collide that way — the same
--    condition opshub#355's identity backfill requires, so the one fix serves both.
--
-- NO BACKFILL for the graph tables: nothing was queued before. `seq` on the existing tables is assigned
-- to existing rows in physical order by ADD COLUMN ... bigserial; their ordering was never meaningful.

ALTER TABLE "messaging"."notification_outbox"
  ADD COLUMN IF NOT EXISTS "seq" bigserial NOT NULL,
  ADD COLUMN IF NOT EXISTS "lease_token" uuid,
  ADD COLUMN IF NOT EXISTS "locked_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "messaging"."email_outbox"
  ADD COLUMN IF NOT EXISTS "seq" bigserial NOT NULL,
  ADD COLUMN IF NOT EXISTS "lease_token" uuid,
  ADD COLUMN IF NOT EXISTS "locked_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "messaging"."webhook_deliveries"
  ADD COLUMN IF NOT EXISTS "seq" bigserial NOT NULL,
  ADD COLUMN IF NOT EXISTS "lease_token" uuid,
  ADD COLUMN IF NOT EXISTS "locked_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "compliance"."compliance_findings" ALTER COLUMN "source" TYPE varchar(255);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messaging"."graph_task_outbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind" varchar(100) NOT NULL,
  "payload" jsonb NOT NULL,
  "ordering_key" varchar(64),
  "dedupe_key" varchar(255),
  "status" "outbox_status" DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "sent_at" timestamp with time zone,
  "seq" bigserial NOT NULL,
  "lease_token" uuid,
  "locked_until" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_graph_task_pending"
  ON "messaging"."graph_task_outbox" USING btree ("status", "seq");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_graph_task_ordering"
  ON "messaging"."graph_task_outbox" USING btree ("ordering_key", "seq")
  WHERE ordering_key IS NOT NULL AND status = 'pending';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_graph_task_pending_dedupe"
  ON "messaging"."graph_task_outbox" USING btree ("dedupe_key")
  WHERE dedupe_key IS NOT NULL AND status = 'pending';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messaging"."graph_sync_state" (
  "name" varchar(100) PRIMARY KEY NOT NULL,
  "cursor" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
DECLARE
  dup text;
BEGIN
  SELECT string_agg(k, ', ') INTO dup FROM (
    SELECT lower(email) AS k FROM "identity"."employees" GROUP BY lower(email) HAVING count(*) > 1 LIMIT 20
  ) d;
  IF dup IS NOT NULL THEN
    RAISE EXCEPTION 'employees collide once their email is lower-cased (%); make them distinct, then re-run', dup;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_employee_email_lower"
  ON "identity"."employees" USING btree (lower("email"));
