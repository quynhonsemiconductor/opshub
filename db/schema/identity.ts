/**
 * identity schema — employees (single-tenant directory, synced from Entra ID).
 */
import { pgSchema, uuid, varchar, jsonb, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { employeeStatusEnum } from './enums';

export const identitySchema = pgSchema('identity');

export const employees = identitySchema.table(
  'employees',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Entra ID object id (oid claim) — null for locally-created records. */
    entraOid: varchar('entra_oid', { length: 64 }),
    email: varchar('email', { length: 255 }).notNull(),
    displayName: varchar('display_name', { length: 200 }).notNull(),
    department: varchar('department', { length: 120 }),
    jobTitle: varchar('job_title', { length: 120 }),
    managerId: uuid('manager_id'),
    /** Application roles, e.g. ['it-admin','security']. Drives RBAC. */
    roles: jsonb('roles').notNull().$type<string[]>().default([]),
    status: employeeStatusEnum('status').notNull().default('active'),
    /** S3 stored_files.id for the employee's profile photo — null until uploaded. */
    photoStorageKey: varchar('photo_storage_key', { length: 512 }),
    /**
     * The first verified Cloudflare Access `sub` this employee used for MCP. Written ONCE, on the
     * first /mcp call, and never changed: the mailbox is the lookup key, and a mailbox can be
     * reassigned, so a different Access identity reaching the same address must be refused rather
     * than inherit the grants (the KB parity fix, kb#388). Nullable for everyone who never used MCP.
     */
    accessSub: varchar('access_sub', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailIdx: uniqueIndex('uq_employee_email').on(t.email),
    // Case-insensitive, matching how identity v8 and the Graph worker compare addresses.
    emailLowerIdx: uniqueIndex('uq_employee_email_lower').on(sql`lower(${t.email})`),
    // Partial: only enforce uniqueness for non-null Entra OIDs.
    // Locally-created employees (no Entra sync) may all have entra_oid = NULL.
    entraIdx: uniqueIndex('uq_employee_entra_oid')
      .on(t.entraOid)
      .where(sql`entra_oid IS NOT NULL`),
    statusIdx: index('ix_employee_status').on(t.status),
    // Partial: NULL is "not bound yet" and may repeat; a bound sub is one person.
    accessSubIdx: uniqueIndex('uq_employee_access_sub')
      .on(t.accessSub)
      .where(sql`access_sub IS NOT NULL`),
  }),
);
