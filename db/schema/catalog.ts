/**
 * Service catalog schema — admin-configurable self-service request templates.
 */
import {
  pgSchema,
  uuid,
  varchar,
  text,
  integer,
  boolean,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';

export const catalogSchema = pgSchema('catalog');

export const catalogItems = catalogSchema.table(
  'catalog_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 150 }).notNull(),
    description: text('description'),
    category: varchar('category', { length: 80 }).notNull().default('other'),
    iconEmoji: varchar('icon_emoji', { length: 10 }).default('📋'),
    /** Platform permission required to approve requests of this catalog item. */
    approvalPermission: varchar('approval_permission', { length: 100 })
      .notNull()
      .default('requests.approve'),
    /** Fulfillment SLA in hours. Null = no SLA. */
    slaHours: integer('sla_hours'),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    categoryIdx: index('ix_ci_category').on(t.category),
    activeIdx: index('ix_ci_active').on(t.isActive, t.sortOrder),
  }),
);
