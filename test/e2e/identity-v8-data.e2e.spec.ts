/**
 * What the identity 8 cutover left in the database, and what it left reachable.
 *
 * The migrations (0036 create, 0037 backfill, 0038 remove v7) run in `pnpm db:migrate` before this suite,
 * so these are assertions about their RESULT on a seeded database:
 *
 *  - every employee is a user with the SAME id: the invariant `employees.id = user.id` that keeps every
 *    foreign key in the product pointing at the right person. A future employee-creating path that forgets
 *    `UserDirectory` fails here;
 *  - the v7 tables are gone, and `employees.entra_oid` (read by the employee API and the Graph code) is not;
 *  - the runtime roles can use the new tables (default privileges, migration 0012), because a table the
 *    app role cannot read is a sign-in that fails only on a deployed database;
 *  - the unauthenticated surface is exactly what it was: probes and the signed inbound webhook, and nothing
 *    else, now that identity's guard is global.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d`, `pnpm db:migrate`, `pnpm db:seed`.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DRIZZLE, type DrizzleDB } from '@platform';
import { createTestApp } from './support/harness';

let app: NestFastifyApplication;
let db: DrizzleDB;

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  const result = await db.execute(query);
  return result.rows as T[];
}

beforeAll(async () => {
  app = await createTestApp();
  db = app.get<DrizzleDB>(DRIZZLE);
}, 60_000);

afterAll(async () => {
  await app?.close();
});

describe('employees and identity users are one person', () => {
  it('every employee has an identity user with the same id and email', async () => {
    const orphans = await rows<{ id: string; email: string }>(sql`
      SELECT e.id, e.email
      FROM identity.employees e
      LEFT JOIN identity."user" u ON u.id = e.id AND lower(u.email) = lower(e.email)
      WHERE u.id IS NULL
    `);

    expect(
      orphans,
      'employees with no identity user of the same id (a path creates employees without UserDirectory)',
    ).toEqual([]);
  });

  it('the email is stored lower-cased on the user (identity matches sign-ins on it)', async () => {
    const bad = await rows<{ id: string }>(
      sql`SELECT id FROM identity."user" WHERE email <> lower(email)`,
    );
    expect(bad).toEqual([]);
  });

  it('an offboarded employee is a banned user', async () => {
    const leakers = await rows<{ id: string }>(sql`
      SELECT e.id FROM identity.employees e
      JOIN identity."user" u ON u.id = e.id
      WHERE e.status = 'offboarded' AND u.banned IS NOT TRUE
    `);
    expect(leakers, 'an offboarded employee can still sign in').toEqual([]);
  });
});

describe('the v7 schema is gone', () => {
  it('has no refresh_tokens and no sso_identities table', async () => {
    const left = await rows<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'identity' AND table_name IN ('refresh_tokens', 'sso_identities')
    `);
    expect(left).toEqual([]);
  });

  it('keeps employees.entra_oid: the employee API and the Graph code read it', async () => {
    const col = await rows<{ column_name: string }>(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'identity' AND table_name = 'employees' AND column_name = 'entra_oid'
    `);
    expect(col).toHaveLength(1);
  });

  it('has the four identity 8 tables the staff preset needs, and no more', async () => {
    const tables = await rows<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'identity' AND table_name <> 'employees' ORDER BY table_name
    `);
    expect(tables.map((t) => t.table_name)).toEqual(['account', 'session', 'user', 'verification']);
  });
});

describe('the runtime roles can use the identity tables', () => {
  it.each(['opshub_app', 'opshub_worker'])('%s may read and write all four', async (role) => {
    const [exists] = await rows<{ ok: boolean }>(
      sql`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${role}) AS ok`,
    );
    // the roles exist on every deployed database; a bare local database may not have them
    if (!exists?.ok) return;

    for (const table of ['user', 'session', 'account', 'verification']) {
      const [priv] = await rows<{ ok: boolean }>(sql`
        SELECT has_table_privilege(${role}, ${`identity."${table}"`}, 'SELECT, INSERT, UPDATE, DELETE') AS ok
      `);
      expect(priv?.ok, `${role} lacks privileges on identity.${table}`).toBe(true);
    }
  });
});

describe('the unauthenticated surface', () => {
  it.each(['/livez', '/v1/healthz', '/v1/readyz'])('%s answers without a session', async (url) => {
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('the signed inbound webhook is reachable without a session (it is authenticated by signature)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/inbound/e2e-unknown-source',
      payload: {},
    });
    // refused for its missing signature or unknown source: anything but "sign in" or a CSRF refusal
    expect(res.statusCode).not.toBe(401);
    expect(res.body.toLowerCase()).not.toContain('csrf');
  });

  it.each([
    ['GET', '/v1/employees'],
    ['GET', '/v1/auth/me'],
    ['GET', '/v1/audit-logs'],
    ['GET', '/v1/assets'],
  ])('%s %s needs a session', async (method, url) => {
    const res = await app.inject({ method: method as 'GET', url });
    expect(res.statusCode).toBe(401);
  });
});
