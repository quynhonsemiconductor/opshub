-- door schema — the RFID door/attendance terminal (ADR: platform/adr/ATTENDANCE-DEVICE.md).
--
-- Three tables: registered terminals (ESP32 controllers), cards owned by employees, and the events
-- the terminals upload. `events.terminal_id` and `events.card_id` are real foreign keys WITHIN the
-- schema, ON DELETE RESTRICT: an event never dangles, and a terminal/card with events cannot be
-- silently deleted. `employee_id` is a plain uuid — no foreign key ACROSS schemas (assertExist
-- validates it, as test/employee-reference.ratchet.spec.ts requires).
--
-- Also drops the orphan `workforce.attendance_logs` (created in 0003, never in the Drizzle schema,
-- only truncated by db/reset.ts) so there is one attendance store.
--
-- Additive apart from that drop: the orphan table had no owner and no readers.

CREATE SCHEMA IF NOT EXISTS "door";--> statement-breakpoint
CREATE TYPE "public"."door_card_status" AS ENUM('active', 'revoked', 'lost');--> statement-breakpoint
CREATE TYPE "public"."door_reader" AS ENUM('in', 'out');--> statement-breakpoint
CREATE TYPE "public"."door_event_result" AS ENUM('allow', 'deny');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "door"."terminals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120) NOT NULL,
	"location" varchar(200),
	"token_hash" varchar(64) NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"dropped_events" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "door"."cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"uid" varchar(20) NOT NULL,
	"label" varchar(200),
	"status" "public"."door_card_status" DEFAULT 'active' NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_until" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_card_uid_shape" CHECK ("door"."cards"."uid" ~ '^[0-9A-F]{8}([0-9A-F]{6}){0,2}$'),
	CONSTRAINT "ck_card_window" CHECK ("door"."cards"."valid_until" IS NULL OR "door"."cards"."valid_until" > "door"."cards"."valid_from"),
	-- status and revoked_at are two views of one fact: an active card is exactly a card with no
	-- revoked_at. The CHECK keeps them from drifting.
	CONSTRAINT "ck_card_status_revoked_at" CHECK ((("door"."cards"."status" = 'active')) = ("door"."cards"."revoked_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "door"."events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"terminal_id" uuid NOT NULL,
	"stream" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"reader" "public"."door_reader" NOT NULL,
	"uid" varchar(20) NOT NULL,
	"result" "public"."door_event_result" NOT NULL,
	"card_id" uuid,
	"device_ts" timestamp with time zone NOT NULL,
	"time_synced" boolean DEFAULT false NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- RESTRICT, not CASCADE: revocation updates the card row, it never deletes it, so a credited
	-- event always has its card; a terminal with events cannot vanish under them.
	CONSTRAINT "events_terminal_id_terminals_id_fk" FOREIGN KEY ("terminal_id") REFERENCES "door"."terminals"("id") ON DELETE RESTRICT,
	CONSTRAINT "events_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "door"."cards"("id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_door_card_active_uid" ON "door"."cards" USING btree ("uid") WHERE "door"."cards"."status" = 'active';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_door_card_uid" ON "door"."cards" USING btree ("uid");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_door_card_employee" ON "door"."cards" USING btree ("employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_door_event_stream_seq" ON "door"."events" USING btree ("terminal_id","stream","seq");--> statement-breakpoint
-- "Unknown cards (last 24 h)": recent card-less events.
CREATE INDEX IF NOT EXISTS "ix_door_event_unknown_recent" ON "door"."events" USING btree ("received_at") WHERE "door"."events"."card_id" IS NULL;--> statement-breakpoint
-- The 24-month retention purge scans by receive date alone (door-event-cleanup).
CREATE INDEX IF NOT EXISTS "ix_door_event_received" ON "door"."events" USING btree ("received_at");--> statement-breakpoint
-- SELF-CHECKING DROP. The orphan table had no owner, so nothing can vouch that it is empty.
-- A non-empty env must fail LOUDLY here instead of silently losing rows: the migration aborts
-- (everything above rolls back), the env is fixed by emptying or archiving the table, then the
-- migration re-runs clean.
DO $$
DECLARE
  orphan_rows bigint;
BEGIN
  IF to_regclass('"workforce"."attendance_logs"') IS NOT NULL THEN
    SELECT count(*) INTO orphan_rows FROM "workforce"."attendance_logs";
    IF orphan_rows > 0 THEN
      RAISE EXCEPTION 'workforce.attendance_logs holds % row(s); archive or empty it before migrating (door ADR: one attendance store)', orphan_rows
        USING HINT = 'The table is dropped by migration 0040 and its data is NOT migrated.';
    END IF;
    DROP TABLE "workforce"."attendance_logs";
  END IF;
END $$;
--> statement-breakpoint

-- ============================================================================
-- Grants
-- ============================================================================
-- `door` is a NEW schema, so migration 0012's blanket grants and default
-- privileges do not reach it — every schema created since has had to grant
-- explicitly, and `db/enable-least-privilege-roles.ts` now derives its schema
-- list so it fails the build if this is forgotten.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_app') THEN
    GRANT USAGE ON SCHEMA door TO opshub_app, opshub_worker, opshub_migrate;

    GRANT SELECT, INSERT, UPDATE, DELETE
      ON ALL TABLES IN SCHEMA door TO opshub_app, opshub_worker;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA door TO opshub_app, opshub_worker;

    GRANT ALL ON SCHEMA door TO opshub_migrate;
    GRANT ALL ON ALL TABLES IN SCHEMA door TO opshub_migrate;
    GRANT ALL ON ALL SEQUENCES IN SCHEMA door TO opshub_migrate;

    ALTER DEFAULT PRIVILEGES IN SCHEMA door
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO opshub_app, opshub_worker;
    ALTER DEFAULT PRIVILEGES IN SCHEMA door
      GRANT USAGE, SELECT ON SEQUENCES TO opshub_app, opshub_worker;
  END IF;
END $$;
