/**
 * An employee's email is one identity however it is cased. `uq_employee_email_lower` (migration 0035)
 * makes `Ada@x` and `ada@x` collide; the Graph worker and identity v8 both compare addresses
 * lower-cased.
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
import { UserDrizzleRepository } from '../../libs/modules/identity/src/infrastructure/shared-auth/user.drizzle-repository';
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

  it('the first SSO login of a mixed-case employee with no link MATCHES the row: no second insert, no 23505', async () => {
    const lowered = `ada.nguyen.${suffix}@qnsc.vn`;
    const row = await legacy(`Ada.Nguyen.${suffix}@QNSC.vn`);
    const users = new UserDrizzleRepository(db);

    const user = await users.upsertBySsoIdentity(
      'entra',
      `sub-${suffix}`,
      `Ada.Nguyen.${suffix}@qnsc.vn`,
      'Ada',
    );

    expect(user.id).toBe(row.id);
    expect(await count(lowered), 'a second employee was inserted').toBe(1);
    await db
      .delete(schema.ssoIdentities)
      .where(eq(schema.ssoIdentities.providerSub, `sub-${suffix}`));
  });

  it('findByEmail on the employee repository finds a mixed-case row by any casing', async () => {
    const row = await legacy(`Grace.Hopper.${suffix}@QNSC.vn`);
    const found = await new EmployeeDrizzleRepository(db).findByEmail(
      `grace.HOPPER.${suffix}@qnsc.vn`,
    );
    expect(found?.id).toBe(row.id);
  });

  it('findByEmail on the user repository finds a mixed-case row by any casing', async () => {
    const row = await legacy(`Alan.Turing.${suffix}@QNSC.vn`);
    const found = await new UserDrizzleRepository(db).findByEmail(`ALAN.turing.${suffix}@qnsc.vn`);
    expect(found?.id).toBe(row.id);
  });

  it('migration 0035 lower-cases and trims the stored addresses BEFORE building the index, and refuses collisions', async () => {
    const statements = readFileSync(
      resolve(__dirname, '../../db/migrations/0035_graph_task_outbox.sql'),
      'utf8',
    )
      .split('--> statement-breakpoint')
      .filter((st) => st.includes('"identity"."employees"'));
    expect(statements).toHaveLength(3); // preflight, normalise, index

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DROP INDEX IF EXISTS identity.uq_employee_email_lower');
      const ids: string[] = [];
      for (const email of [`Mixed.${suffix}@QNSC.vn`, ` padded.${suffix}@qnsc.vn `]) {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO identity.employees (email, display_name) VALUES ($1, 'x') RETURNING id`,
          [email],
        );
        ids.push(rows[0].id);
      }

      for (const st of statements) await client.query(st);

      const { rows } = await client.query<{ email: string }>(
        'SELECT email FROM identity.employees WHERE id = ANY($1) ORDER BY email',
        [ids],
      );
      expect(rows.map((r) => r.email)).toEqual([
        `mixed.${suffix}@qnsc.vn`,
        `padded.${suffix}@qnsc.vn`,
      ]);

      // A pair that collides only once lower-cased and trimmed: the preflight must refuse, naming it.
      await client.query('DROP INDEX identity.uq_employee_email_lower');
      await client.query('SAVEPOINT collide');
      await client.query(`INSERT INTO identity.employees (email, display_name) VALUES ($1, 'x')`, [
        ` MIXED.${suffix}@qnsc.vn`,
      ]);
      await expect(client.query(statements[0])).rejects.toThrow(
        /collide once their email is lower-cased/,
      );
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
