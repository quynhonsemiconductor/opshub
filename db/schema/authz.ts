/**
 * Authorization (RBAC) schema — fine-grained permissions, groups (named sets of permissions), the groups
 * employees belong to (scoped), permissions granted to one employee directly, and approval delegations.
 * Coexists with the `identity.employees.group_keys` jsonb column, a cache of each person's group keys that
 * `/auth/me` displays; the PolicyGuard resolves effective permissions from these tables.
 */
import {
  pgSchema,
  uuid,
  varchar,
  text,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { membershipSourceEnum, scopeTypeEnum } from './enums';

export const authzSchema = pgSchema('authz');

/** Catalog of all permission keys (resource.action), e.g. `asset.reassign`. */
export const permissions = authzSchema.table('permissions', {
  key: varchar('key', { length: 120 }).primaryKey(),
  description: text('description').notNull(),
});

/** Named group of permissions, e.g. `it-admin`. */
export const groups = authzSchema.table(
  'groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: varchar('key', { length: 64 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    /** System groups are seed-managed and cannot be deleted via the API. */
    system: boolean('system').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    keyUq: uniqueIndex('uq_group_key').on(t.key),
  }),
);

/** Group → permission membership (many-to-many). */
export const groupPermissions = authzSchema.table(
  'group_permissions',
  {
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    permissionKey: varchar('permission_key', { length: 120 })
      .notNull()
      .references(() => permissions.key, { onDelete: 'cascade' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.groupId, t.permissionKey] }),
  }),
);

/**
 * Scoped membership of an employee in a group. `scopeType=global` (scopeId null) grants the
 * group's permissions everywhere; narrower scopes (team/dept/region/self) constrain the grant
 * to matching resources. Optional `expiresAt` supports time-boxed access.
 */
export const employeeGroups = authzSchema.table(
  'employee_groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id').notNull(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    scopeType: scopeTypeEnum('scope_type').notNull().default('global'),
    scopeId: varchar('scope_id', { length: 120 }),
    grantedBy: uuid('granted_by').notNull(),
    /** `idp` rows follow the identity provider's claims at each sign-in; `manual` rows are only ever changed by a person. */
    source: membershipSourceEnum('source').notNull().default('manual'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Two partial indexes cover both cases:
    // 1. Global assignments (scope_id IS NULL) — enforce uniqueness ignoring the NULL column.
    // 2. Scoped assignments (scope_id IS NOT NULL) — standard composite uniqueness.
    // This avoids the PostgreSQL NULL != NULL gotcha in unique indexes.
    uniqGlobal: uniqueIndex('uq_employee_group_global')
      .on(t.employeeId, t.groupId, t.scopeType)
      .where(sql`scope_id IS NULL`),
    uniqScoped: uniqueIndex('uq_employee_group_scoped')
      .on(t.employeeId, t.groupId, t.scopeType, t.scopeId)
      .where(sql`scope_id IS NOT NULL`),
    employeeIdx: index('ix_employee_group_employee').on(t.employeeId),
  }),
);

/**
 * A permission granted to ONE employee directly, outside any group — the exception path.
 *
 * Group membership is how almost everyone gets their permissions. This table is for the one-off: a single
 * extra permission that does not justify a group of its own. It carries what `employee_groups`
 * carries — a scope, an optional expiry, who granted it — plus a `reason`, because a grant that bypasses
 * the groups has to say why it exists.
 */
export const employeePermissions = authzSchema.table(
  'employee_permissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id').notNull(),
    permissionKey: varchar('permission_key', { length: 120 })
      .notNull()
      .references(() => permissions.key, { onDelete: 'cascade' }),
    scopeType: scopeTypeEnum('scope_type').notNull().default('global'),
    scopeId: varchar('scope_id', { length: 120 }),
    grantedBy: uuid('granted_by').notNull(),
    /** Why this employee holds the permission outside a group. Required: an exception is explained. */
    reason: text('reason').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Same pair of partial indexes as `employee_groups`: NULL scope_id is distinct in a unique index.
    uniqGlobal: uniqueIndex('uq_employee_permission_global')
      .on(t.employeeId, t.permissionKey, t.scopeType)
      .where(sql`scope_id IS NULL`),
    uniqScoped: uniqueIndex('uq_employee_permission_scoped')
      .on(t.employeeId, t.permissionKey, t.scopeType, t.scopeId)
      .where(sql`scope_id IS NOT NULL`),
    employeeIdx: index('ix_employee_permission_employee').on(t.employeeId),
  }),
);

/**
 * Temporary transfer of a user's approval authority to a delegate over a window
 * (e.g. while on leave). Consumed by the request/approval engine.
 */
export const approvalDelegations = authzSchema.table(
  'approval_delegations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fromUserId: uuid('from_user_id').notNull(),
    toUserId: uuid('to_user_id').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    fromActiveIdx: index('ix_deleg_from_active').on(t.fromUserId, t.endsAt),
    // Needed by findActiveDelegationTo() — queried on every approve/reject.
    toActiveIdx: index('ix_deleg_to_active').on(t.toUserId, t.endsAt),
  }),
);
