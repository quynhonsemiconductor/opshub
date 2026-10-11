-- Graph work moves out of API requests: an outbox the API writes and only the worker relays, plus the
-- persisted resume position of the Intune device sync.
--
-- NO BACKFILL. Nothing was queued before; the calls this replaces were made inline and either
-- succeeded or logged. Default privileges (migration 0012) give the runtime roles their access.

CREATE TABLE IF NOT EXISTS "messaging"."graph_task_outbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind" varchar(100) NOT NULL,
  "payload" jsonb NOT NULL,
  "dedupe_key" varchar(255),
  "status" "outbox_status" DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_graph_task_pending"
  ON "messaging"."graph_task_outbox" USING btree ("status", "next_attempt_at");
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
