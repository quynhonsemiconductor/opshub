/**
 * An employee's email is one identity however it is cased. `uq_employee_email_lower` (migration 0035)
 * makes `Ada@x` and `ada@x` collide; the Graph worker and identity v8 both compare addresses
 * lower-cased.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d`, `pnpm db:migrate` (migration 0035).
 */
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../db/schema';
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
