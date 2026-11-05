/**
 * notifications schema — in_app_notifications + notification_preferences
 * Stores all in-app notification records per employee, plus per-user channel
 * opt-out preferences.
 * Written by the notification relay after reading notification_outbox.
 */
import {
  pgSchema,
  uuid,
  varchar,
  text,
  boolean,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const notificationsSchema = pgSchema('notifications');

export const inAppNotifications = notificationsSchema.table(
  'in_app_notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recipientId: uuid('recipient_id').notNull(),
    actorId: uuid('actor_id'),
    /** Dot-namespaced event type, e.g. 'access_request.approved'. */
    type: varchar('type', { length: 100 }).notNull(),
    title: varchar('title', { length: 500 }).notNull(),
    body: text('body'),
    resourceType: varchar('resource_type', { length: 50 }),
    resourceId: uuid('resource_id'),
    metadata: jsonb('metadata').notNull().$type<Record<string, unknown>>().default({}),
    isRead: boolean('is_read').notNull().default(false),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Populated by the relay with the outbox row id — prevents duplicate delivery. */
    sourceEventId: uuid('source_event_id'),
  },
  (t) => ({
    recipientIdx: index('ix_ian_recipient').on(t.recipientId, t.isRead),
    createdIdx: index('ix_ian_created').on(t.recipientId, t.createdAt),
    resourceIdx: index('ix_ian_resource').on(t.resourceType, t.resourceId),
    // Partial: only deduplicate when an outbox source event ID is present.
    sourceEventIdx: uniqueIndex('uq_ian_source_event_id')
      .on(t.sourceEventId)
      .where(sql`source_event_id IS NOT NULL`),
  }),
);

/**
 * notification_preferences — per-user channel opt-out configuration.
 *
 * type = '*'          → wildcard / master switch (applies to all event types)
 * type = 'access_request.approved' → specific event type
 *
 * Resolution order: specific type row > wildcard ('*') row > default (enabled).
 * inApp  = false → suppresses in-app delivery for matching notifications.
 * email  = false → suppresses email delivery for matching notifications.
 */
export const notificationPreferences = notificationsSchema.table(
  'notification_preferences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    /** '*' = wildcard master switch; specific event type string otherwise. */
    type: varchar('type', { length: 100 }).notNull(),
    inApp: boolean('in_app').notNull().default(true),
    email: boolean('email').notNull().default(true),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userTypeIdx: uniqueIndex('uq_notif_pref_user_type').on(t.userId, t.type),
  }),
);
