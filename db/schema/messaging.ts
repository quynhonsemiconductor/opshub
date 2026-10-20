/**
 * messaging schema — transactional outbox tables.
 *
 * notification_outbox  — in-app notification queue, relayed every 5s by cron
 * email_outbox         — email send queue, relayed every 5s by cron
 * webhook_deliveries   — outbound webhook queue, relayed every 10s by cron
 * graph_task_outbox    — Microsoft Graph work the API requests and only the worker performs
 * graph_sync_state     — resume position of the Intune device sync (not an outbox)
 *
 * All three follow the same pattern: written in the caller's DB transaction, relayed by a
 * cron service using SELECT … FOR UPDATE SKIP LOCKED, and every one of them has a real
 * consumer at the far end.
 *
 * A fourth table, outbox_events, used to sit here — a generic domain-event outbox relayed
 * to SQS. Nothing consumed the queue and nothing read the table, so migration 0013 dropped
 * it. Do not reintroduce a generic event outbox without a consumer: rova shipped exactly
 * that shape and lost 100% of its domain events in every deployed environment for months,
 * because nothing exercised the middle of the chain.
 */
import {
  pgSchema,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
  boolean,
  integer,
  bigserial,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { outboxStatusEnum } from './enums';

export const messagingSchema = pgSchema('messaging');

/**
 * The columns every outbox table carries for lease-and-fence relaying (see AbstractOutboxRelay).
 *
 *   seq          claim order. Rows are processed in `seq` order, so "oldest first" no longer depends on
 *                a timestamp that retries rewrite.
 *   leaseToken   who holds the row right now. Every state change a relay makes is `WHERE id = $1 AND
 *                lease_token = $2`, so a relay whose lease expired (a slow call, a paused process)
 *                cannot overwrite what the relay that took over has done.
 *   lockedUntil  when the lease lapses. A row is claimable only when this is null or in the past.
 *
 * Why not just hold the row lock for the call: a relay used to keep one transaction (and its row
 * locks) open across the external call. A long call outlives the database role's
 * idle_in_transaction_session_timeout, the session is killed, and the whole batch rolls back with its
 * attempt counters — so the row never dead-letters and the loop is silent.
 */
const outboxLease = () => ({
  seq: bigserial('seq', { mode: 'number' }).notNull(),
  leaseToken: uuid('lease_token'),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
});

// ── Notification outbox ──────────────────────────────────────────────────────

export const notificationOutbox = messagingSchema.table(
  'notification_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recipientId: uuid('recipient_id').notNull(),
    actorId: uuid('actor_id'),
    type: varchar('type', { length: 100 }).notNull(),
    vars: jsonb('vars').notNull().$type<Record<string, unknown>>(),
    resourceId: uuid('resource_id'),
    status: outboxStatusEnum('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    idempotencyKey: varchar('idempotency_key', { length: 255 }),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull().defaultNow(),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    ...outboxLease(),
  },
  (t) => ({
    pendingIdx: index('ix_notif_outbox_pending').on(t.status, t.scheduledAt),
    // Partial: only enforce idempotency when a key is provided.
    idempotencyIdx: uniqueIndex('uq_notif_outbox_idempotency')
      .on(t.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
  }),
);

// ── Email outbox ─────────────────────────────────────────────────────────────

export const emailOutbox = messagingSchema.table(
  'email_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    to: varchar('to', { length: 320 }).notNull(),
    template: varchar('template', { length: 100 }).notNull(),
    vars: jsonb('vars').notNull().$type<Record<string, unknown>>(),
    status: outboxStatusEnum('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    idempotencyKey: varchar('idempotency_key', { length: 255 }),
    /**
     * Optional: the internal user ID this email was scheduled for.
     * Populated for notification emails (e.g. access_request.approved).
     * NULL for transactional emails without a known recipient user.
     * Used to check notification_preferences before sending.
     */
    recipientId: uuid('recipient_id'),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    /**
     * The provider's message id, stored by the relay at acceptance so the asynchronous
     * feedback loop can match a bounce/complaint event back to this row (SES echoes it
     * as `mail.messageId` in every event notification). NULL for rows sent before the
     * loop existed, and for providers without an id (dev).
     */
    messageId: varchar('message_id', { length: 255 }),
    /** When the feedback loop recorded a bounce or complaint. NULL unless it did. */
    feedbackAt: timestamp('feedback_at', { withTimezone: true }),
    ...outboxLease(),
  },
  (t) => ({
    pendingIdx: index('ix_email_outbox_pending').on(t.status, t.scheduledAt),
    // Partial: only enforce idempotency when a key is provided.
    idempotencyIdx: uniqueIndex('uq_email_outbox_idempotency')
      .on(t.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
    // The feedback loop's only lookup: match an inbound SES event to its row.
    messageIdIdx: index('ix_email_outbox_message_id')
      .on(t.messageId)
      .where(sql`message_id IS NOT NULL`),
  }),
);

// ── Webhook subscriptions ─────────────────────────────────────────────────────
//
// External systems register a URL + secret + list of event types they want
// to receive.  The delivery outbox (below) fans out a row per subscription
// each time a matching domain event fires.

export const webhookSubscriptions = messagingSchema.table(
  'webhook_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    url: varchar('url', { length: 2048 }).notNull(),
    /** HMAC-SHA256 signing secret.  Never returned in GET responses. */
    secret: varchar('secret', { length: 255 }).notNull(),
    /** Domain event types this subscription listens to, e.g. ['request.approved']. */
    events: text('events').array().notNull().default([]),
    description: varchar('description', { length: 500 }),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    activeIdx: index('ix_webhook_sub_active').on(t.active),
  }),
);

// ── Webhook delivery outbox ───────────────────────────────────────────────────

export const webhookDeliveries = messagingSchema.table(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * CASCADE, and it needs the constraint to be real: this was `notNull()` with no reference at
     * all, so hard-deleting a subscription left its deliveries pointing at nothing. The relay claims
     * work with an INNER JOIN onto the subscription, so an orphan stayed `pending` with
     * `attempts = 0` forever — never retried, never dead-lettered, invisible to the alarm that
     * watches the dead-letter field. See migration 0031.
     */
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => webhookSubscriptions.id, { onDelete: 'cascade' }),
    eventType: varchar('event_type', { length: 100 }).notNull(),
    payload: jsonb('payload').notNull().$type<Record<string, unknown>>(),
    status: outboxStatusEnum('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    ...outboxLease(),
  },
  (t) => ({
    pendingIdx: index('ix_webhook_del_pending').on(t.status, t.nextAttemptAt),
    subIdx: index('ix_webhook_del_sub').on(t.subscriptionId),
  }),
);

// ── Graph task outbox ────────────────────────────────────────────────────────

/**
 * Work that needs Microsoft Graph, written by the API and executed ONLY by the worker.
 *
 * The API holds no Graph credential. A request that needs Graph — disabling an Entra account when an
 * offboarding is approved, revoking that person's sessions, an on-demand shadow-IT scan — writes a row
 * here, in the SAME transaction as the business change, and the worker's `GraphTaskRelayService`
 * performs it with retries. Roll the transaction back and the task never exists; commit it and the
 * task survives a crash of either process.
 *
 * `kind` is a varchar, not an enum: the set is owned by `libs/modules/graph` and a new kind should not
 * need a migration. The relay refuses a kind it does not know and dead-letters the row.
 */
export const graphTaskOutbox = messagingSchema.table(
  'graph_task_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: varchar('kind', { length: 100 }).notNull(),
    payload: jsonb('payload').notNull().$type<Record<string, unknown>>(),
    /**
     * Tasks that share a key run ONE AT A TIME, in `seq` order: a row is claimable only when no
     * earlier row with the same key is still pending. Account tasks carry the employee id here, so two
     * tasks for one person never overlap. Null for tasks with no ordering need.
     */
    orderingKey: varchar('ordering_key', { length: 64 }),
    /** At most one PENDING row per key; null for tasks where two in a row are both meant. */
    dedupeKey: varchar('dedupe_key', { length: 255 }),
    status: outboxStatusEnum('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    ...outboxLease(),
  },
  (t) => ({
    pendingIdx: index('ix_graph_task_pending').on(t.status, t.seq),
    orderingIdx: index('ix_graph_task_ordering')
      .on(t.orderingKey, t.seq)
      .where(sql`ordering_key IS NOT NULL AND status = 'pending'`),
    dedupeIdx: uniqueIndex('uq_graph_task_pending_dedupe')
      .on(t.dedupeKey)
      .where(sql`dedupe_key IS NOT NULL AND status = 'pending'`),
  }),
);

/**
 * Where the Intune device sync resumes. One row per sync name, so the position survives a worker
 * restart or a new task: an in-memory link restarted every sync from the full device list.
 */
export const graphSyncState = messagingSchema.table('graph_sync_state', {
  name: varchar('name', { length: 100 }).primaryKey(),
  /** The `lastSyncDateTime` high-water mark of the last COMPLETE pass. */
  cursor: text('cursor'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
