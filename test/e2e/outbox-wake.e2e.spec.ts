/**
 * The outbox wake-up (PostgreSQL NOTIFY, outbox-wake.ts) against a real database.
 *
 * NOTIFY is a hint: it wakes the relays early, and polling is the source of truth. So the tests cover the hint's
 * contract (after commit, never on rollback, back after a dropped connection) and the fallback (a notify that never
 * arrives still leaves its row for the next poll).
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GraphAccountRelayService } from '../../libs/modules/graph/src/application/graph-task-relay.service';
import { GRAPH_TASK } from '../../libs/modules/graph/src/graph-task';
import * as schema from '../../db/schema';
import type { DrizzleDB, DrizzleTx } from '@platform';
import { notifyOutbox, OUTBOX_WAKE_APPLICATION_NAME, OutboxWakeListener } from '@platform';

const { graphTaskOutbox } = schema;

let pool: Pool;
let db: DrizzleDB;
let listener: OutboxWakeListener;
let received: string[];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `predicate` holds, failing with `what` if it does not within `ms`. */
async function waitUntil(predicate: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await sleep(25);
  }
}

function silentLogger() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

beforeAll(async () => {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is required');
  pool = new Pool({ connectionString: url, max: 4 });
  db = drizzle(pool, { schema });
  listener = new OutboxWakeListener({
    config: { connectionString: url },
    logger: silentLogger(),
    minBackoffMs: 100,
    maxBackoffMs: 500,
  });
  received = [];
  listener.onWake((kind) => received.push(kind));
  await listener.start();
  await waitUntil(() => listener.listening, 'the listener to LISTEN');
});

afterAll(async () => {
  await listener?.stop();
  await pool?.end();
});

describe('outbox wake-up: NOTIFY from the writer, LISTEN in the worker', () => {
  it('is delivered only after the transaction commits, not while it is open', async () => {
    const kind = `after-commit-${Date.now()}`;

    await db.transaction(async (tx) => {
      await notifyOutbox(tx, kind);
      await sleep(300);
      expect(received, 'the wake arrived before the commit').not.toContain(kind);
    });

    await waitUntil(() => received.includes(kind), 'the wake after commit');
  });

  it('is never delivered for a rolled-back transaction', async () => {
    const kind = `rolled-back-${Date.now()}`;

    await expect(
      db.transaction(async (tx) => {
        await notifyOutbox(tx, kind);
        throw new Error('rolled back on purpose');
      }),
    ).rejects.toThrow('rolled back on purpose');

    await sleep(500);
    expect(received).not.toContain(kind);
  });

  it('comes back after the listener connection is dropped', async () => {
    // Terminate the listener's own backend. The pool's connections are not its application name, so they survive.
    await db.execute(
      sql`select pg_terminate_backend(pid) from pg_stat_activity where application_name = ${OUTBOX_WAKE_APPLICATION_NAME}`,
    );
    await waitUntil(() => !listener.listening, 'the listener to notice the drop');
    await waitUntil(() => listener.listening, 'the listener to reconnect and LISTEN again');

    const kind = `after-reconnect-${Date.now()}`;
    await db.transaction((tx) => notifyOutbox(tx, kind));
    await waitUntil(() => received.includes(kind), 'the wake after reconnect');
  });

  it('a notify that never arrives is still picked up by the next poll (polling is the source of truth)', async () => {
    // The worker is not listening: the notify is lost, and only the row is left behind.
    await listener.stop();
    const employee = `missed-notify-${Date.now()}`;
    const [task] = await db.transaction(async (tx: DrizzleTx) => {
      const inserted = await tx
        .insert(graphTaskOutbox)
        .values({
          kind: GRAPH_TASK.ACCOUNT_RECONCILE,
          payload: { employeeId: employee },
          orderingKey: employee,
        })
        .returning();
      await notifyOutbox(tx, 'graph');
      return inserted;
    });

    // No wake comes. The relay's cron tick is the same call: relay() runs and claims the row.
    const reconcile = vi.fn(() => Promise.resolve());
    const relay = new GraphAccountRelayService(
      db,
      { isEnabled: () => true } as never,
      { reconcile } as never,
      { detectShadowIt: vi.fn() } as never,
      { runPostureSync: vi.fn() } as never,
      { run: async (_n: string, _t: number, fn: () => Promise<void>) => fn() } as never,
    );
    await relay.relay();

    expect(
      reconcile.mock.calls.filter((c: unknown[]) => c[0] === employee),
      'the poll did not take the row whose notify was lost',
    ).toHaveLength(1);
    const row = (await db.select().from(graphTaskOutbox).where(eq(graphTaskOutbox.id, task.id)))[0];
    expect(row.status).toBe('sent');

    listener = new OutboxWakeListener({
      config: { connectionString: process.env['DATABASE_URL']! },
      logger: silentLogger(),
    });
    listener.onWake((kind) => received.push(kind));
    await listener.start();
  });
});
