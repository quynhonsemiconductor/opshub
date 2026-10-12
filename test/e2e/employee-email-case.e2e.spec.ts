/**
 * An employee's email is one identity however it is cased. `uq_employee_email_lower` (migration 0035)
 * makes `Ada@x` and `ada@x` collide; the Graph worker and the identity 8 sign-in hook both compare
 * addresses lower-cased.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d`, `pnpm db:migrate` (migration 0035).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../db/schema';
import {
  StaffSignInHandler,
  StaffSignInRefusedError,
} from '../../libs/modules/identity/src/infrastructure/auth/staff-sign-in.handler';
import { EmployeeDrizzleRepository } from '../../libs/modules/identity/src/infrastructure/persistence/employee.drizzle-repository';
import type { DrizzleDB } from '@platform';

let pool: Pool;
let db: DrizzleDB;
const suffix = Date.now().toString(36);
const created: string[] = [];

beforeAll(() => {
  pool = new Pool({ connectionString: process.env['DATABASE_URL'], max: 2 });
  db = drizzle(pool, { schema });
});
afterAll(async () => {
  for (const id of created) await db.delete(schema.employees).where(eq(schema.employees.id, id));
  await pool.end();
});

describe('employee email is case-insensitive, against PostgreSQL', () => {
  it('the repository stores a mixed-case address lower-cased', async () => {
    const repo = new EmployeeDrizzleRepository(db);
    const employee = await repo.create({
      email: `  Ada.${suffix}@Example.COM `,
      displayName: 'Ada',
    });
    created.push(employee.id);

    expect(employee.email).toBe(`ada.${suffix}@example.com`);
  });

  it('the database REFUSES a second employee whose address differs only by case', async () => {
    const [first] = await db
      .insert(schema.employees)
      .values({ email: `grace.${suffix}@example.com`, displayName: 'Grace' })
      .returning();
    created.push(first.id);

    const attempt = db
      .insert(schema.employees)
      .values({ email: `GRACE.${suffix}@Example.com`, displayName: 'Grace again' });

    // Drizzle wraps the driver error; the constraint name is on `cause`.
    const err: unknown = await attempt.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err, 'a differently-cased duplicate was accepted').toBeDefined();
    expect(String((err as { cause?: { message?: string } }).cause?.message)).toMatch(
      /uq_employee_email_lower/,
    );
  });
});

describe('EXISTING mixed-case employees keep working, against PostgreSQL', () => {
  /** A row written before addresses were normalised (the unique index is on lower(email), so it is allowed). */
  const legacy = async (email: string) => {
    const [row] = await db
      .insert(schema.employees)
      .values({ email, displayName: 'Legacy' })
      .returning();
    created.push(row.id);
    return row;
  };
  const count = async (lowered: string) =>
    (
      await db
        .select({ id: schema.employees.id })
        .from(schema.employees)
        .where(sql`lower(${schema.employees.email}) = ${lowered}`)
    ).length;

  /** The sign-in hook with a stub role sync: this suite is about WHICH employee it finds, not about roles. */
  const hook = () =>
    new StaffSignInHandler(db, { syncUserRolesByKeys: () => Promise.resolve([]) } as never);

  it('the sign-in of a mixed-case employee MATCHES the row: no second insert, no 23505', async () => {
    const lowered = `ada.nguyen.${suffix}@qnsc.vn`;
    const row = await legacy(`Ada.Nguyen.${suffix}@QNSC.vn`);

    // identity gives the hook the lower-cased address and, by the migration's invariant, the employee's own id
    await hook().handle({
      user: { id: row.id, email: lowered, name: 'Ada' },
      claims: { oid: `oid-${suffix}`, email: lowered, guest: false, roles: [] },
    });

    expect(await count(lowered), 'a second employee was inserted').toBe(1);
  });

  it('a user that is NOT the employee (a returning person whose user row is gone) is refused, and still no second row', async () => {
    const lowered = `alan.kay.${suffix}@qnsc.vn`;
    await legacy(`Alan.Kay.${suffix}@QNSC.vn`);

    await expect(
      hook().handle({
        user: { id: '00000000-0000-4000-8000-0000000000aa', email: lowered, name: 'Alan' },
        claims: { oid: `oid2-${suffix}`, email: lowered, guest: false, roles: [] },
      }),
    ).rejects.toBeInstanceOf(StaffSignInRefusedError);

    expect(await count(lowered), 'a second employee was inserted').toBe(1);
  });

  it('findByEmail on the employee repository finds a mixed-case row by any casing', async () => {
    const row = await legacy(`Grace.Hopper.${suffix}@QNSC.vn`);
    const found = await new EmployeeDrizzleRepository(db).findByEmail(
      `grace.HOPPER.${suffix}@qnsc.vn`,
    );
    expect(found?.id).toBe(row.id);
  });

  it('migration 0035 lower-cases and trims the stored addresses BEFORE building the index, and refuses collisions', async () => {
    const statements = readFileSync(
      resolve(__dirname, '../../db/migrations/0035_graph_task_outbox.sql'),
      'utf8',
    )
      .split('--> statement-breakpoint')
      .filter((st) => st.includes('"identity"."employees"'));
    // The ORDER is the point: preflight, then normalise, then the index that needs normalised data.
    expect(statements).toHaveLength(3);
    const [preflight, normalise, index] = statements as [string, string, string];
    expect(preflight).toMatch(/RAISE EXCEPTION/);
    expect(normalise).toMatch(
      /UPDATE "identity"\."employees" SET "email" = lower\(btrim\("email"\)\)/,
    );
    expect(index).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "uq_employee_email_lower"/);

    // The DML steps run for real, in a transaction that is rolled back. (The index is DDL, which the
    // runtime role this suite connects as cannot run; it is covered by the migration upgrade path job.)
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const ids: string[] = [];
      for (const email of [`Mixed.${suffix}@QNSC.vn`, ` padded.${suffix}@qnsc.vn `]) {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO identity.employees (email, display_name) VALUES ($1, 'x') RETURNING id`,
          [email],
        );
        ids.push(rows[0].id);
      }

      await client.query(preflight);
      await client.query(normalise);

      const { rows } = await client.query<{ email: string }>(
        'SELECT email FROM identity.employees WHERE id = ANY($1) ORDER BY email',
        [ids],
      );
      expect(rows.map((r) => r.email)).toEqual([
        `mixed.${suffix}@qnsc.vn`,
        `padded.${suffix}@qnsc.vn`,
      ]);

      // Collides only once lower-cased AND trimmed (the plain unique indexes cannot see it): refused.
      await client.query(`INSERT INTO identity.employees (email, display_name) VALUES ($1, 'x')`, [
        ` MIXED.${suffix}@qnsc.vn`,
      ]);
      await expect(client.query(preflight)).rejects.toThrow(
        /collide once their email is lower-cased/,
      );
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
