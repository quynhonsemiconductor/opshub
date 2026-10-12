/**
 * identity schema — employees (single-tenant directory, synced from Entra ID).
 */
import {
  pgSchema,
  uuid,
  varchar,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  boolean,
} from 'drizzle-orm/pg-core';
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
  }),
);

/**
 * Server-side refresh token table.
 * Raw tokens never leave the server — only the SHA-256 hash is stored.
 * This allows instant revocation (logout, offboarding, security incident).
 */
export const refreshTokens = identitySchema.table(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id').notNull(),
    /** SHA-256(rawToken). Raw token lives only in the HttpOnly cookie — never stored. */
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    /**
     * Family ID groups all rotated tokens from the same login.
     * If a revoked token is used (theft detection), the entire family is revoked.
     * Copied from Rally's auth_sessions pattern.
     */
    familyId: uuid('family_id').notNull(),
    /** Always 'sso' — session established via Entra ID OIDC. Kept as varchar for forward compatibility. */
    authMethod: varchar('auth_method', { length: 10 }).notNull().default('sso'),
    /**
     * Authorization context scope for the session. Single-tenant (opshub) always
     * `null`; the column exists so the shared `@qnsc-vn/identity` AuthService can
     * treat opshub and multi-tenant products uniformly.
     */
    contextId: varchar('context_id', { length: 120 }),
    /** SSO provider that established the session ('entra'); null for non-SSO. */
    ssoProvider: varchar('sso_provider', { length: 32 }),
    /** CSRF token for double-submit cookie protection; null for pre-migration sessions. */
    csrfToken: varchar('csrf_token', { length: 64 }),
    /** True once the token has been rotated or explicitly revoked. */
    revoked: boolean('revoked').notNull().default(false),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    hashIdx: uniqueIndex('uq_refresh_token_hash').on(t.tokenHash),
    employeeIdx: index('ix_refresh_token_employee').on(t.employeeId),
    familyIdx: index('ix_refresh_token_family').on(t.familyId),
    expiryIdx: index('ix_refresh_token_expiry').on(t.expiresAt),
  }),
);

/**
 * SSO identity links — maps an external IdP subject (Entra `oid`) to an
 * employee. The shared `@qnsc-vn/identity` AuthService resolves and JIT-provisions
 * users through this table (`findSsoIdentity` / `upsertBySsoIdentity`) instead of
 * reading `entra_oid` off the employee directly, so multiple providers can link
 * to one account. `employees.entra_oid` is kept in sync for existing RBAC queries.
 */
export const ssoIdentities = identitySchema.table(
  'sso_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    /** IdP discriminator, e.g. 'entra'. */
    provider: varchar('provider', { length: 32 }).notNull(),
    /** Stable IdP subject id (Entra `oid`). */
    providerSub: varchar('provider_sub', { length: 255 }).notNull(),
    /** Email as asserted by the IdP at last login. */
    providerEmail: varchar('provider_email', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    providerSubIdx: uniqueIndex('uq_sso_identity_provider_sub').on(t.provider, t.providerSub),
    userIdx: index('ix_sso_identity_user').on(t.userId),
  }),
);
