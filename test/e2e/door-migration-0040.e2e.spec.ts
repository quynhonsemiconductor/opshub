/**
 * Migration 0040's orphan-table drop must be SELF-CHECKING (ADR ATTENDANCE-DEVICE §6, SA review):
 * `workforce.attendance_logs` is dropped to leave one attendance store, but nothing owned the
 * table, so nothing can vouch it is empty. The migration therefore RAISEs on a non-empty table
 * (failing loudly instead of losing data) and drops silently only when empty — or when the table
 * never existed. These tests pin all three paths against a real database.
 *
 * Privileges: the e2e role can neither CREATE TABLE in existing schemas nor DROP tables it does
 * not own. So the DROP branch runs on a TEMP table over ONE dedicated pooled connection (temp
 * tables are per-session; unqualified names resolve pg_temp first). The RAISE branch needs no
 * privileges (it fires before any drop) and runs against a real seeded table.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d`, `pnpm db:migrate`, `pnpm db:seed`.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
 * A DO block cannot take bind parameters (08P01), so callers interpolate the table name raw.
 */
function doBlock(table: string): string {
  return `
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
  `;
}

describe('migration 0040 self-checking orphan drop', () => {
  it('drops an EMPTY orphan table silently (temp table on one connection)', async () => {
    const client = await db.$client.connect();
    try {
      await client.query(
        'CREATE TEMP TABLE door_orphan_scratch (id uuid primary key default gen_random_uuid())',
      );
      await client.query(doBlock('door_orphan_scratch'));
      const still = await client.query<{ exists_after: boolean }>(
        "SELECT to_regclass('door_orphan_scratch') IS NOT NULL AS exists_after",
      );
      expect(still.rows[0]?.exists_after).toBe(false);
    } finally {
      client.release();
    }
  });

  it('RAISES on a non-empty orphan table, leaving it intact (real seeded table)', async () => {
    // authz.permissions is seeded by every run and never empty — the RAISE fires before any
    // drop, so the seeded table must survive the failed block untouched.
    const err = (await db
      .execute(sql.raw(doBlock('authz.permissions')))
      .catch((e: Error & { cause?: Error }) => e)) as Error & { cause?: Error };
    expect((err.cause as Error)?.message ?? err.message).toMatch(/holds \d+ row\(s\)/);
    const still = await db.execute<{ exists_after: boolean }>(
      sql`SELECT to_regclass('authz.permissions') IS NOT NULL AS exists_after`,
    );
    expect(still.rows[0]?.exists_after).toBe(true);
  });

  it('is a no-op when the orphan table never existed', async () => {
    const client = await db.$client.connect();
    try {
      // The DO block returns void; drizzle surfaces it as an empty Result — assert no throw.
      await client.query(doBlock('door_orphan_never_existed'));
    } finally {
      client.release();
    }
  });
});
