/**
 * door schema — the RFID door/attendance terminal (ADR: platform/adr/ATTENDANCE-DEVICE.md).
 *
 * Three tables: the registered TERMINALS (ESP32 controllers), the CARDS (owned by employees), and
 * the EVENTS the terminals upload. `events.terminal_id` and `events.card_id` are real foreign keys
 * WITHIN this schema (ON DELETE RESTRICT — an event never dangles, and a terminal/card with events
 * cannot be silently deleted). `cards.employee_id` stays a soft reference into `identity`: no
 * foreign key across schemas, validated with `assertExist` like every other identity reference
 * (test/employee-reference.ratchet.spec.ts).
 */
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgSchema,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
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
    /** Set by revoke and mark-lost; the CHECK makes status and revoked_at two views of one fact. */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uidShape: check('ck_card_uid_shape', sql`${t.uid} ~ '^[0-9A-F]{8}([0-9A-F]{6}){0,2}$'`),
    // The window must be non-empty, and status/revoked_at must AGREE: an active card is exactly a
    // card with no revoked_at. Two views of one fact will drift otherwise.
    windowShape: check(
      'ck_card_window',
      sql`${t.validUntil} IS NULL OR ${t.validUntil} > ${t.validFrom}`,
    ),
    statusMatchesRevocation: check(
      'ck_card_status_revoked_at',
      sql`(${t.status} = 'active') = (${t.revokedAt} IS NULL)`,
    ),
    // A UID can be REISSUED after revocation (lost card replaced): uniqueness holds per active card
    // only. Allowing exactly one active card per UID is what makes the terminal's allow-list and the
    // event-time card resolution unambiguous.
    oneActivePerUid: uniqueIndex('uq_door_card_active_uid')
      .on(t.uid)
      .where(sql`status = 'active'`),
    // The event-time card resolution looks candidates up by UID (PR for the terminal API); the
    // active-UID unique index above does not serve a uid-only scan.
    uidIdx: index('ix_door_card_uid').on(t.uid),
    employeeIdx: index('ix_door_card_employee').on(t.employeeId),
  }),
);

export const events = doorSchema.table(
  'events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The terminal that reported the event — a real FK; a terminal with events cannot vanish. */
    terminalId: uuid('terminal_id')
      .notNull()
      .references(() => terminals.id, { onDelete: 'restrict' }),
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
     * The card the swipe is credited to, resolved at insert BY EVENT TIME (uid + validity window),
     * not "the card active now" — so a buffered event uploaded after a UID was reissued lands on
     * the holder's page. RESTRICT, not CASCADE: revocation updates the card row, it never deletes
     * it, so a credited event always has its card.
     */
    cardId: uuid('card_id').references(() => cards.id, { onDelete: 'restrict' }),
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
    // "Unknown cards (last 24 h)": recent card-less events.
    unknownCardsIdx: index('ix_door_event_unknown_recent')
      .on(t.receivedAt)
      .where(sql`card_id IS NULL`),
    // The 24-month retention purge scans by receive date alone (door-event-cleanup).
    receivedIdx: index('ix_door_event_received').on(t.receivedAt),
  }),
);
