/**
 * door schema — the RFID door/attendance terminal (ADR: platform/adr/ATTENDANCE-DEVICE.md).
 *
 * Three tables: the registered TERMINALS (ESP32 controllers), the CARDS (owned by employees), and
 * the EVENTS the terminals upload. There is deliberately no cross-schema foreign key — `employee_id`
 * is validated with `assertExist` like every other reference into `identity`
 * (test/employee-reference.ratchet.spec.ts). `card_id → door.cards` is within this schema, but the
 * reference is still soft (plain uuid column): an event's `card_id` is resolved at insert time by
 * event time and must survive the card's later deletion of its active window (revocation never
 * deletes), so the column stays a plain uuid.
 */
import {
  check,
  index,
  integer,
  pgSchema,
  uuid,
  varchar,
  timestamp,
  bigint,
  boolean,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { doorCardStatusEnum, doorEventResultEnum, doorReaderEnum } from './enums';

export const doorSchema = pgSchema('door');

export const terminals = doorSchema.table('terminals', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 120 }).notNull(),
  /** Where the terminal physically stands, e.g. 'Main door — outside reader'. */
  location: varchar('location', { length: 200 }),
  /** sha256 hex of the bearer secret. The secret itself is shown once at creation, never stored. */
  tokenHash: varchar('token_hash', { length: 64 }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  /** Running total of events the terminal reported dropping (full buffer). */
  droppedEvents: integer('dropped_events').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const cards = doorSchema.table(
  'cards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** identity.employees.id — no cross-schema FK; assertExist validates it. */
    employeeId: uuid('employee_id').notNull(),
    /**
     * Card UID, uppercase hex without separators, 8/14/20 chars (4/7/10-byte UIDs). The CHECK makes
     * `04a1…` and `04A1…` the same card: writes are normalised, the constraint is the backstop.
     */
    uid: varchar('uid', { length: 20 }).notNull(),
    label: varchar('label', { length: 200 }),
    status: doorCardStatusEnum('status').notNull().default('active'),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull().defaultNow(),
    /** Null = no expiry (permanent card). */
    validUntil: timestamp('valid_until', { withTimezone: true }),
    /** Set by revoke and mark-lost. */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uidShape: check('ck_card_uid_shape', sql`${t.uid} ~ '^[0-9A-F]{8}([0-9A-F]{6}){0,2}$'`),
    // A UID can be REISSUED after revocation (lost card replaced): uniqueness holds per active card
    // only. Allowing exactly one active card per UID is what makes the terminal's allow-list and the
    // event-time card resolution unambiguous.
    oneActivePerUid: uniqueIndex('uq_door_card_active_uid')
      .on(t.uid)
      .where(sql`status = 'active'`),
    employeeIdx: index('ix_door_card_employee').on(t.employeeId),
  }),
);

export const events = doorSchema.table(
  'events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** door.terminals.id — same schema, still a plain uuid: events outlive nothing, but the
     * identity-drizzle convention keeps every reference soft unless Drizzle declares it. */
    terminalId: uuid('terminal_id').notNull(),
    /** UUID the terminal generates per boot-strapped identity (new board, reflash, NVS erase). */
    stream: uuid('stream').notNull(),
    /** Monotonic within the stream. bigint: a decade of one door never nears int4 range... but a
     * firmware bug could count fast, and the column costs nothing. */
    seq: bigint('seq', { mode: 'number' }).notNull(),
    reader: doorReaderEnum('reader').notNull(),
    /** The UID the reader reported; unknown cards (card_id null) are how new cards get enrolled. */
    uid: varchar('uid', { length: 20 }).notNull(),
    result: doorEventResultEnum('result').notNull(),
    /**
     * The card active AT THE EVENT, resolved at insert by event time (uid + validity window), not
     * "the card active now". Null = no card owned that UID when the person swiped. Never FK'd: a
     * historical event must survive any later card row change.
     */
    cardId: uuid('card_id'),
    deviceTs: timestamp('device_ts', { withTimezone: true }).notNull(),
    /** True when the terminal had a clock (NTP or a Date-header fallback) at capture. */
    timeSynced: boolean('time_synced').notNull().default(false),
    /** The DB clock at receive — the audit stamp, never shown as event time. */
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // The event key: a terminal whose NVS was wiped starts a NEW stream, so a reset counter can
    // never collide with its own old events (they would be silently discarded as duplicates).
    oneEventPerStreamSeq: uniqueIndex('uq_door_event_stream_seq').on(t.terminalId, t.stream, t.seq),
    // The two read paths: "unknown cards (last 24 h)" and the retention purge.
    unknownCardsIdx: index('ix_door_event_unknown_recent')
      .on(t.receivedAt)
      .where(sql`card_id IS NULL`),
  }),
);
