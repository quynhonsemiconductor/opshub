-- door schema — the RFID door/attendance terminal (ADR: platform/adr/ATTENDANCE-DEVICE.md).
--
-- Three tables: registered terminals (ESP32 controllers), cards owned by employees, and the events
-- the terminals upload. `employee_id` is a plain uuid (no cross-schema FK — assertExist validates
-- it, as test/employee-reference.ratchet.spec.ts requires); `card_id` is resolved at insert time by
-- event time and stays a plain uuid so historical events never dangle on a card row change.
--
-- Also drops the orphan `workforce.attendance_logs` (created in 0003, never in the Drizzle schema,
-- only truncated by db/reset.ts) so there is one attendance store.
--
-- Additive apart from that drop: the orphan table had no owner and no readers.

CREATE SCHEMA "door";--> statement-breakpoint
CREATE TYPE "public"."door_card_status" AS ENUM('active', 'revoked', 'lost');--> statement-breakpoint
CREATE TYPE "public"."door_reader" AS ENUM('in', 'out');--> statement-breakpoint
CREATE TYPE "public"."door_event_result" AS ENUM('allow', 'deny');--> statement-breakpoint
CREATE TABLE "door"."terminals" (
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
CREATE TABLE "door"."cards" (
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
	CONSTRAINT "ck_card_uid_shape" CHECK ("door"."cards"."uid" ~ '^[0-9A-F]{8}([0-9A-F]{6}){0,2}$')
);
--> statement-breakpoint
CREATE TABLE "door"."events" (
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
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_door_card_active_uid" ON "door"."cards" USING btree ("uid") WHERE "door"."cards"."status" = 'active';--> statement-breakpoint
CREATE INDEX "ix_door_card_employee" ON "door"."cards" USING btree ("employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_door_event_stream_seq" ON "door"."events" USING btree ("terminal_id","stream","seq");--> statement-breakpoint
CREATE INDEX "ix_door_event_unknown_recent" ON "door"."events" USING btree ("received_at") WHERE "door"."events"."card_id" IS NULL;--> statement-breakpoint
DROP TABLE IF EXISTS "workforce"."attendance_logs";
