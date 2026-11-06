/**
 * The retention delete against REAL Postgres: its predicate must leave PENDING outbox work alone
 * and count terminal age from `terminal_at`, not from when the row was scheduled.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DrizzleDB } from '@platform';
import { RetentionCleanupCron } from '../../apps/worker/src/cron/retention-cleanup.cron';
import { notificationOutbox } from '../../db/schema';

const url = process.env['DATABASE_URL'];
if (!url) throw new Error('this spec needs DATABASE_URL');

const pool = new Pool({ connectionString: url, max: 1 });
const db = drizzle(pool) as unknown as DrizzleDB;

const pendingId = randomUUID();
const oldTerminalId = randomUUID();
const newTerminalId = randomUUID();
const marker = `e2e-retention-${randomUUID()}`;

beforeAll(async () => {
  // This spec runs the purge in APPLY mode across every rule table. Refuse unless the DSN points
  // at a disposable test database, so a stray local .env can never delete real rows.
  const { rows } = await pool.query<{ name: string }>('SELECT current_database() AS name');
  const name = rows[0]?.name ?? '';
  if (!/_(test|fresh|e2e)$/.test(name)) {
    throw new Error(
      `retention e2e refuses to run against database "${name}": point DATABASE_URL at a ` +
        'disposable test database (name matching *test / *fresh / *e2e).',
    );
  }

  const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  const oldTerminal = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  await db.insert(notificationOutbox).values([
    // PENDING, scheduled 60 days ago: never deletable, however old.
    {
      id: pendingId,
      recipientId: randomUUID(),
      type: marker,
      vars: {},
      status: 'pending',
      scheduledAt: old,
    },
    // Terminal 40 days ago: deletable.
    {
      id: oldTerminalId,
      recipientId: randomUUID(),
      type: marker,
      vars: {},
      status: 'sent',
      scheduledAt: old,
      dispatchedAt: oldTerminal,
      terminalAt: oldTerminal,
    },
    // Scheduled long ago but terminal NOW: must survive (the retry case).
    {
      id: newTerminalId,
      recipientId: randomUUID(),
      type: marker,
      vars: {},
      status: 'sent',
      scheduledAt: old,
      dispatchedAt: new Date(),
      terminalAt: new Date(),
    },
  ]);
});

afterAll(async () => {
  await db.delete(notificationOutbox).where(eq(notificationOutbox.type, marker));
  await pool.end();
});

describe('retention cleanup (real Postgres)', () => {
  it('deletes only terminal rows older than the cap, counting from terminal_at', async () => {
    const cron = new RetentionCleanupCron(
      db,
      { run: (_name: string, _ttl: number, fn: () => Promise<void>) => fn() } as never,
      { get: () => false } as never,
    );
    await cron.purge();

    const rows = await db
      .select({ id: notificationOutbox.id })
      .from(notificationOutbox)
      .orderBy(notificationOutbox.id);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(pendingId);
    expect(ids).toContain(newTerminalId);
    expect(ids).not.toContain(oldTerminalId);
  });
});
