/**
 * Seed script — two tiers (mirrors rally's seed architecture):
 *
 *   1. RBAC reference catalogue (permissions + roles + grants) — PROD-SAFE.
 *      Reference data the PolicyGuard and JIT SSO provisioning depend on; it
 *      must exist in EVERY environment (dev, staging AND production). Exported
 *      as `seedRbacCatalog` so db/migrate.ts runs it unconditionally. Idempotent
 *      and authoritative: descriptions/names reconcile via onConflictDoUpdate and
 *      each system role's permission set is rebuilt so catalogue edits take effect
 *      on re-run (unlike the previous onConflictDoNothing, which silently ignored
 *      edits).
 *
 *   2. Demo fixtures (login-able employees, one per system role) — DEV/E2E ONLY.
 *      Exported as `seed`, gated behind SEED_ON_DEPLOY and refused on a real
 *      production deploy. Lets `POST /api/auth/test-login` mint a session without
 *      hand-inserting employees (and creates the matching `identity.user` rows, same ids). Idempotent via fixed UUIDs + onConflictDoNothing.
 *
 * Run standalone : pnpm db:seed          (catalogue + demo fixtures)
 * Called by      : db/migrate.ts — seedRbacCatalog always; seed when SEED_ON_DEPLOY=true
 */
try {
  process.loadEnvFile('.env');
} catch {
  /* no .env in CI */
}

import { drizzle } from 'drizzle-orm/node-postgres';
import { inArray, eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { pgOptions, tlsFromEnv } from './pg-ssl';
import { resolveDatabaseUrl } from './database-url';
import { log } from './script-log';
import { permissions, roles, rolePermissions, userRoleAssignments } from './schema/authz';
import { employees } from './schema/identity';
import { user as identityUser } from './schema/identity-auth';
import { controls } from './schema/isms-controls';
import { ANNEX_A_CONTROLS } from './annex-a-controls';
import {
  PERMISSION,
  PERMISSION_DESCRIPTIONS,
  ROLE,
  ROLE_NAMES,
  ROLE_PERMISSIONS,
  WILDCARD_PERMISSION,
} from './permissions.catalog';

type SeedDb = ReturnType<typeof drizzle>;

// ── Permission catalogue + roles ──────────────────────────────────────────────
// Sourced from db/permissions.catalog.ts, which the backend decorators and the
// frontend gating also read. Defining them inline here is what let the seeded
// vocabulary drift from the one the app used.
const PERMISSIONS: Array<{ key: string; description: string }> = [
  { key: WILDCARD_PERMISSION, description: 'Wildcard — grants every permission (admin only)' },
  ...Object.values(PERMISSION).map((key) => ({
    key,
    description: PERMISSION_DESCRIPTIONS[key],
  })),
];

const ROLES: Array<{ key: string; name: string; permissions: string[] }> = Object.values(ROLE).map(
  (key) => ({ key, name: ROLE_NAMES[key], permissions: [...ROLE_PERMISSIONS[key]] }),
);

// ── Demo employees — one per system role, for RBAC + test-login testing ───────
// Fixed UUIDs keep re-seeds idempotent. Each employee gets the matching legacy
// `employees.roles` jsonb (the denormalised copy) AND a global
// `user_role_assignments` row (drives effective permissions via authz.resolve).
// Sign in locally with any of these via `POST /api/auth/test-login` (IDENTITY_TEST_LOGIN=enabled).
const ADMIN_EMPLOYEE_ID = '00000000-0000-7000-8000-000000000001';

/**
 * A SECOND admin, for the browser suite only.
 *
 * The rate limiter keys the DEFAULT tier (200 req/min) on the user id, and the Playwright suite signs in
 * as one principal for every spec — around 15 API calls per page load, times forty-odd specs inside two
 * minutes, which crosses that line and fails whichever request lands next with a 429. Measured, twice,
 * once as an "upload broken" report that was nothing of the kind.
 *
 * Two admins let the suite split its spec files between them and stay inside a limit that protects
 * production. The alternative was making the limit configurable, which is a control weakened for the
 * convenience of tests.
 */
const E2E_ADMIN_EMPLOYEE_ID = '00000000-0000-7000-8000-000000000009';
/*
 * EIGHT SEATS, AND WHY IT IS EIGHT.
 *
 * Four seats were assigned per spec FILE, round-robin. That spread the load across files and did nothing
 * about the load INSIDE one, which is where the limit was actually being crossed: with `workers: 1` only
 * one file runs at a time, so one file's burst is one identity's burst. Measured from the API log on a
 * full browser run: 268 requests in a single 60-second window on one seat, against a tier of 200. More
 * seats assigned the same way would not have moved that number at all.
 *
 * So a seat now belongs to a TEST rather than to a file. The busiest file holds seven tests and a test
 * averages around forty requests, so eight seats leave every test its own bucket with room to spare —
 * and eight is the count because seven is the most tests any one file has, not because it is a round
 * number.
 */
const E2E_ADMIN_THIRD_EMPLOYEE_ID = '00000000-0000-7000-8000-00000000000a';
const E2E_ADMIN_FOURTH_EMPLOYEE_ID = '00000000-0000-7000-8000-00000000000b';
const E2E_ADMIN_FIFTH_EMPLOYEE_ID = '00000000-0000-7000-8000-00000000000c';
const E2E_ADMIN_SIXTH_EMPLOYEE_ID = '00000000-0000-7000-8000-00000000000d';
const E2E_ADMIN_SEVENTH_EMPLOYEE_ID = '00000000-0000-7000-8000-00000000000e';
const E2E_ADMIN_EIGHTH_EMPLOYEE_ID = '00000000-0000-7000-8000-00000000000f';
const DEMO_EMPLOYEES: Array<{
  id: string;
  email: string;
  displayName: string;
  roleKey: string;
}> = [
  {
    id: ADMIN_EMPLOYEE_ID,
    email: 'admin@opshub.local',
    displayName: 'Admin User',
    roleKey: 'admin',
  },
  {
    id: E2E_ADMIN_EMPLOYEE_ID,
    email: 'admin2@opshub.local',
    displayName: 'Admin User (second seat)',
    roleKey: 'admin',
  },
  {
    id: E2E_ADMIN_THIRD_EMPLOYEE_ID,
    email: 'admin3@opshub.local',
    displayName: 'Admin User (third seat)',
    roleKey: 'admin',
  },
  {
    id: E2E_ADMIN_FOURTH_EMPLOYEE_ID,
    email: 'admin4@opshub.local',
    displayName: 'Admin User (fourth seat)',
    roleKey: 'admin',
  },
  {
    id: E2E_ADMIN_FIFTH_EMPLOYEE_ID,
    email: 'admin5@opshub.local',
    displayName: 'Admin User (fifth seat)',
    roleKey: 'admin',
  },
  {
    id: E2E_ADMIN_SIXTH_EMPLOYEE_ID,
    email: 'admin6@opshub.local',
    displayName: 'Admin User (sixth seat)',
    roleKey: 'admin',
  },
  {
    id: E2E_ADMIN_SEVENTH_EMPLOYEE_ID,
    email: 'admin7@opshub.local',
    displayName: 'Admin User (seventh seat)',
    roleKey: 'admin',
  },
  {
    id: E2E_ADMIN_EIGHTH_EMPLOYEE_ID,
    email: 'admin8@opshub.local',
    displayName: 'Admin User (eighth seat)',
    roleKey: 'admin',
  },
  {
    id: '00000000-0000-7000-8000-000000000002',
    email: 'it.admin@opshub.local',
    displayName: 'IT Administrator',
    roleKey: 'it-admin',
  },
  {
    id: '00000000-0000-7000-8000-000000000003',
    email: 'security@opshub.local',
    displayName: 'Security Officer',
    roleKey: 'security',
  },
  {
    id: '00000000-0000-7000-8000-000000000004',
    email: 'hr@opshub.local',
    displayName: 'HR Manager',
    roleKey: 'hr',
  },
  {
    id: '00000000-0000-7000-8000-000000000005',
    email: 'manager@opshub.local',
    displayName: 'People Manager',
    roleKey: 'manager',
  },
  {
    id: '00000000-0000-7000-8000-000000000006',
    email: 'helpdesk@opshub.local',
    displayName: 'Help Desk',
    roleKey: 'helpdesk',
  },
  {
    id: '00000000-0000-7000-8000-000000000007',
    email: 'auditor@opshub.local',
    displayName: 'Auditor',
    roleKey: 'auditor',
  },
  {
    id: '00000000-0000-7000-8000-000000000008',
    email: 'employee@opshub.local',
    displayName: 'Regular Employee',
    roleKey: 'employee',
  },
];

// ── Tier 1: RBAC reference catalogue (prod-safe) ─────────────────────────────
/**
 * Seed the permission catalogue, system roles and their permission grants.
 * PROD-SAFE reference data — no demo fixtures. Authoritative: role→permission
 * membership is rebuilt per role so removed/added grants reconcile on re-run.
 */
async function seedRbacCatalogInto(db: SeedDb): Promise<void> {
  await db.transaction(async (tx) => {
    // 1. Permission catalog — upsert so descriptions reconcile on re-run.
    await tx
      .insert(permissions)
      .values(PERMISSIONS)
      .onConflictDoUpdate({
        target: permissions.key,
        set: { description: sql`excluded.description` },
      });

    // 2. System roles — upsert so display names reconcile on re-run.
    await tx
      .insert(roles)
      .values(ROLES.map((r) => ({ key: r.key, name: r.name, system: true })))
      .onConflictDoUpdate({
        target: roles.key,
        set: { name: sql`excluded.name`, system: sql`excluded.system` },
      });

    const roleRows = await tx
      .select({ id: roles.id, key: roles.key })
      .from(roles)
      .where(
        inArray(
          roles.key,
          ROLES.map((r) => r.key),
        ),
      );
    const roleIdByKey = new Map(roleRows.map((r) => [r.key, r.id]));

    // 3. Role → permission membership — rebuild each system role's grants so the
    //    join table is authoritative (edits to a role's permission list apply).
    for (const r of ROLES) {
      const roleId = roleIdByKey.get(r.key);
      if (!roleId) continue;
      await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
      if (r.permissions.length > 0) {
        await tx
          .insert(rolePermissions)
          .values(r.permissions.map((permissionKey) => ({ roleId, permissionKey })))
          .onConflictDoNothing();
      }
    }
  });

  log.info(`✅ RBAC catalogue seeded: ${PERMISSIONS.length} permissions | ${ROLES.length} roles`);
}

/**
 * ISO 27001 Annex A, as reference data rather than as a migration.
 *
 * IT WAS A MIGRATION FIRST, AND THAT WAS WRONG. `db/reset.ts` truncates `isms.controls` before every API
 * e2e run — it has to, because `uq_control_reference` is global and a leftover control makes the next
 * run's first insert a 409 — and a migration does not run twice, so the catalogue disappeared and did not
 * come back. Measured: 93 controls before the suite, 20 after. The sibling reference tables
 * (`classification_levels`, `vendor_criticality_levels`) survive only because reset deliberately leaves
 * them alone, which it cannot do here: this table also holds an organisation's CUSTOM controls.
 *
 * So it belongs where reference data that shares a table with real data belongs: in the always-run seed,
 * idempotent on the reference, restoring itself after every reset.
 */
async function seedControlCatalogueInto(db: SeedDb): Promise<void> {
  await db
    .insert(controls)
    .values(
      ANNEX_A_CONTROLS.map((control) => ({
        reference: control.reference,
        title: control.title,
        theme: control.theme,
        source: 'annex_a' as const,
      })),
    )
    // On the reference, not the id: the ids are generated, and a re-seed must not duplicate A.5.1.
    .onConflictDoNothing({ target: controls.reference });
}

/**
 * Standalone entrypoint that seeds ONLY the RBAC reference catalogue. Safe on
 * every deploy in every environment — including real production — because it
 * contains no demo fixtures. Exported so db/migrate.ts runs it unconditionally.
 */
export async function seedRbacCatalog(connectionUrl?: string): Promise<void> {
  // resolveDatabaseUrl accepts a complete DATABASE_URL or composes one from the
  // DATABASE_* parts, and throws naming what is missing. See db/database-url.ts.
  const url = connectionUrl ?? resolveDatabaseUrl();

  const pool = new Pool({ ...pgOptions(url, tlsFromEnv()), max: 1 });
  const db = drizzle(pool);
  try {
    await seedRbacCatalogInto(db);
    // Reference data, like the permissions above: safe in every environment, including production.
    await seedControlCatalogueInto(db);
  } finally {
    await pool.end();
  }
}

// ── Tier 2: demo fixtures (dev/E2E only) ─────────────────────────────────────
/**
 * Seed login-able demo employees (one per system role) plus their global role
 * assignments. DEV/E2E fixtures only. The primary admin email is overridable via
 * ADMIN_EMAIL (default admin@opshub.local).
 */
async function seedDemoEmployeesInto(db: SeedDb): Promise<void> {
  const adminEmail = process.env['ADMIN_EMAIL'] ?? 'admin@opshub.local';

  // 1. Employees — `employees.roles` is the denormalised copy of the role assignments below.
  await db
    .insert(employees)
    .values(
      DEMO_EMPLOYEES.map((e) => ({
        id: e.id,
        // Keyed on the PRIMARY admin's id, not on its role. `ADMIN_EMAIL` overrides one seat, and the
        // condition used to be `roleKey === 'admin'` — which rewrote every admin-role fixture to the same
        // address, so the second seat collided on `employees.email`, was dropped by
        // `onConflictDoNothing`, and test-login minted a NEW user instead of finding the fixture.
        email: e.id === ADMIN_EMPLOYEE_ID ? adminEmail : e.email,
        displayName: e.displayName,
        roles: [e.roleKey],
        status: 'active' as const,
      })),
    )
    .onConflictDoNothing();

  // 1b. The identity user of each fixture, with the SAME id (`identity.user.id = identity.employees.id`):
  // `/api/auth/test-login` finds an existing user by email, and creates a NEW one (new id) if there is none,
  // which would sever the fixture from every foreign key it is the target of.
  const seeded = await db
    .select({
      id: employees.id,
      email: employees.email,
      displayName: employees.displayName,
      status: employees.status,
    })
    .from(employees)
    .where(
      inArray(
        employees.id,
        DEMO_EMPLOYEES.map((e) => e.id),
      ),
    );
  await db
    .insert(identityUser)
    .values(
      seeded.map((e) => ({
        id: e.id,
        name: e.displayName,
        email: e.email.toLowerCase(),
        emailVerified: true,
        banned: e.status === 'offboarded',
      })),
    )
    .onConflictDoNothing();

  // 2. Global role assignments — drive effective permissions via authz.resolve.
  const roleRows = await db
    .select({ id: roles.id, key: roles.key })
    .from(roles)
    .where(
      inArray(
        roles.key,
        DEMO_EMPLOYEES.map((e) => e.roleKey),
      ),
    );
  const roleIdByKey = new Map(roleRows.map((r) => [r.key, r.id]));

  for (const e of DEMO_EMPLOYEES) {
    const roleId = roleIdByKey.get(e.roleKey);
    if (!roleId) continue;
    await db
      .insert(userRoleAssignments)
      .values({
        userId: e.id,
        roleId,
        scopeType: 'global',
        grantedBy: ADMIN_EMPLOYEE_ID,
      })
      .onConflictDoNothing();
  }

  log.info(`✅ Demo employees seeded: ${DEMO_EMPLOYEES.length} (one per role)`);
}

/**
 * Full dev/E2E seed: RBAC catalogue + demo fixtures. Refused on a real production
 * deploy (NODE_ENV=production) unless SEED_ON_DEPLOY=true opts in (develop runs
 * NODE_ENV=production but seeds intentionally). Idempotent.
 */
export async function seed(connectionUrl?: string): Promise<void> {
  if (process.env['NODE_ENV'] === 'production' && process.env['SEED_ON_DEPLOY'] !== 'true') {
    throw new Error('Seed (demo fixtures) must not run in production (NODE_ENV=production).');
  }

  // resolveDatabaseUrl accepts a complete DATABASE_URL or composes one from the
  // DATABASE_* parts, and throws naming what is missing. See db/database-url.ts.
  const url = connectionUrl ?? resolveDatabaseUrl();

  const pool = new Pool({ ...pgOptions(url, tlsFromEnv()), max: 1 });
  const db = drizzle(pool);
  try {
    // Reference catalogue first so role assignments below resolve.
    await seedRbacCatalogInto(db);
    await seedControlCatalogueInto(db);
    await seedDemoEmployeesInto(db);
  } finally {
    await pool.end();
  }
}

// Run directly: pnpm db:seed
if (process.argv[1]?.endsWith('seed.ts') || process.argv[1]?.endsWith('seed.js')) {
  seed().catch((err) => {
    log.error({ err }, 'Seed failed');
    process.exit(1);
  });
}
