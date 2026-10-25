/**
 * Migration 0040's orphan-table drop must be SELF-CHECKING (ADR ATTENDANCE-DEVICE §6, SA review):
 * `workforce.attendance_logs` is dropped to leave one attendance store, but nothing owned the
 * table, so nothing can vouch it is empty. The migration therefore RAISEs on a non-empty table
 * (failing loudly instead of losing data) and drops silently only when empty — or when the table
 * never existed. These tests pin both paths against a real database, using scratch tables that
 * mirror what the DO block checks (`to_regclass` + count), so no migration re-run is needed.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d`, `pnpm db:migrate`.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DRIZZLE, type DrizzleDB } from '@platform';
import { createTestApp } from './support/harness';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

let app: NestFastifyApplication;
let db: DrizzleDB;

beforeAll(async () => {
  app = await createTestApp();
  db = app.get<DrizzleDB>(DRIZZLE);
});

afterAll(async () => {
  await app?.close();
});

/**
 * The DO block from migration 0040, verbatim except that the orphan table name is a parameter.
 * Duplicated ON PURPOSE: the migration is frozen once applied (its text must never change after
 * shipping), so the test pins the SHIPPED logic against regressions rather than importing it.
 */
async function runSelfCheckingDrop(table: string): Promise<void> {
  // A DO block cannot take bind parameters (08P01), and the table name is test-controlled, so
  // the whole block is interpolated raw — mirroring the migration's literal text.
  await db.execute(
    sql.raw(`
    DO $$
    DECLARE
      orphan_rows bigint;
    BEGIN
      IF to_regclass('${table}') IS NOT NULL THEN
        SELECT count(*) INTO orphan_rows FROM ${table};
        IF orphan_rows > 0 THEN
          RAISE EXCEPTION 'workforce.attendance_logs holds % row(s); archive or empty it before migrating (door ADR: one attendance store)', orphan_rows
            USING HINT = 'The table is dropped by migration 0040 and its data is NOT migrated.';
        END IF;
        DROP TABLE ${table};
      END IF;
    END $$;
  `),
  );
}

describe('migration 0040 self-checking orphan drop', () => {
  // `public` only: the CI test DB user cannot CREATE SCHEMA (migrations own the schemas),
  // and the DO block only needs a scratch table to mirror the orphan's shape.
  const SCRATCH = 'public.door_orphan_scratch';

  beforeEach(async () => {
    await db.execute(sql`DROP TABLE IF EXISTS ${sql.raw(SCRATCH)}`);
    await db.execute(
      sql`CREATE TABLE ${sql.raw(SCRATCH)} (id uuid primary key default gen_random_uuid())`,
    );
  });

  it('drops an EMPTY orphan table silently', async () => {
    await runSelfCheckingDrop(SCRATCH);
    const exists = await db.execute<{ regclass: string }>(
      sql`SELECT to_regclass(${sql.raw(`'${SCRATCH}'`)}) IS NOT NULL AS regclass`,
    );
    expect(exists.rows[0]?.regclass).toBe(false);
  });

  it('FAILS LOUDLY on a non-empty orphan table, leaving the table intact', async () => {
    await db.execute(sql`INSERT INTO ${sql.raw(SCRATCH)} DEFAULT VALUES`);
    // Drizzle wraps the RAISE as "Failed query: …" with the server error on `cause`.
    const err = (await runSelfCheckingDrop(SCRATCH).catch((e: Error) => e)) as Error & {
      cause?: Error;
    };
    expect((err.cause as Error)?.message ?? err.message).toMatch(/holds 1 row\(s\)/);
    const exists = await db.execute<{ regclass: string }>(
      sql`SELECT to_regclass(${sql.raw(`'${SCRATCH}'`)}) IS NOT NULL AS regclass`,
    );
    expect(exists.rows[0]?.regclass).toBe(true);
  });

  it('is a no-op when the orphan table never existed', async () => {
    await db.execute(sql`DROP TABLE IF EXISTS ${sql.raw(SCRATCH)}`);
    await expect(runSelfCheckingDrop(SCRATCH)).resolves.toBeUndefined();
  });
});
