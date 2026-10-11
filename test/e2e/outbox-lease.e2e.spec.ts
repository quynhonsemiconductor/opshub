/**
 * The lease-and-fence relay against a REAL PostgreSQL, using the Graph task relay as the vehicle.
 *
 * The unit spec (libs/platform/src/outbox/abstract-outbox-relay.spec.ts) tests the loop with the SQL
 * steps replaced. These are the assertions only a database can make:
 *
 *   - NO SESSION IS "idle in transaction" while the external call runs. That is the property the old
 *     relay lacked: it held one transaction open across the call, and the runtime role's
 *     idle_in_transaction_session_timeout killed the session — rolling back the batch AND its attempt
 *     counters, so the row never dead-lettered and the loop was silent.
 *   - the claim spends the attempt in SQL, a lapsed lease with every attempt used is dead-lettered, and
 *     a live lease hides the row;
 *   - the fence: a relay that lost its lease writes nothing;
 *   - per-employee ordering: a task is not claimable while an earlier one for the same employee is
 *     pending, running, or backing off.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d`, `pnpm db:migrate` (migration 0035).
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphTaskRelayService } from '../../libs/modules/graph/src/application/graph-task-relay.service';
import { GRAPH_TASK } from '../../libs/modules/graph/src/graph-task';
import * as schema from '../../db/schema';
import type { DrizzleDB } from '@platform';

const { graphTaskOutbox } = schema;

let pool: Pool;
let observer: Pool;
let db: DrizzleDB;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function makeRelay(overrides: { reconcile?: (employeeId: string) => Promise<void> } = {}) {
  const reconcile = vi.fn(overrides.reconcile ?? (() => Promise.resolve()));
  const relay = new GraphTaskRelayService(
    db,
    { isEnabled: () => true } as never,
    { reconcile } as never,
    { detectShadowIt: vi.fn() } as never,
    { runPostureSync: vi.fn() } as never,
    { run: (_n: string, _t: number, fn: () => Promise<void>) => fn() } as never,
  );
  return { relay, reconcile };
}

async function insertTask(
  employeeId: string,
  extra: Partial<typeof graphTaskOutbox.$inferInsert> = {},
) {
  const [row] = await db
    .insert(graphTaskOutbox)
    .values({
      kind: GRAPH_TASK.ACCOUNT_RECONCILE,
      payload: { employeeId },
      orderingKey: employeeId,
      ...extra,
    })
    .returning();
  return row;
}

const load = async (id: string) =>
  (await db.select().from(graphTaskOutbox).where(eq(graphTaskOutbox.id, id)))[0];

beforeAll(() => {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is required');
  pool = new Pool({ connectionString: url, max: 4 });
  observer = new Pool({ connectionString: url, max: 1 });
  db = drizzle(pool, { schema });
});
afterAll(async () => {
  await pool?.end();
  await observer?.end();
});
beforeEach(async () => {
  await db.delete(graphTaskOutbox);
});

describe('lease-and-fence relay, against PostgreSQL', () => {
  it('holds NO transaction open while the external call runs', async () => {
    const task = await insertTask('emp-idle');
    let idleInTransaction = -1;
    const { relay } = makeRelay({
      reconcile: async () => {
        // Look from a different connection while the call is in flight.
        const { rows } = await observer.query<{ n: string }>(
          `SELECT count(*) AS n FROM pg_stat_activity
            WHERE datname = current_database() AND pid <> pg_backend_pid()
              AND state IN ('idle in transaction', 'idle in transaction (aborted)')`,
        );
        idleInTransaction = Number(rows[0].n);
        await sleep(250);
      },
    });

    await relay.relay();

    expect(idleInTransaction, 'a session sat idle in transaction across the Graph call').toBe(0);
    expect((await load(task.id)).status).toBe('sent');
  });

  it('spends the attempt at claim, so a failure is recorded with the attempt counted', async () => {
    const task = await insertTask('emp-fail');
    const { relay } = makeRelay({ reconcile: () => Promise.reject(new Error('boom')) });
    const before = Date.now();

    await relay.relay();

    const row = await load(task.id);
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(row.lastError).toBe('boom');
    // Backed off ~30 s, and the lease is released so the retry can be claimed when due.
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(before + 25_000);
    expect(row.leaseToken).toBeNull();
    expect(row.lockedUntil).toBeNull();
  });

  it('dead-letters at once on a NonRetryable failure (a 403 will not heal)', async () => {
    const task = await insertTask('emp-403');
    const { relay } = makeRelay({
      reconcile: () => Promise.reject(Object.assign(new Error('Forbidden'), { statusCode: 403 })),
    });

    await relay.relay();

    const row = await load(task.id);
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(1);
    expect(row.lastError).toMatch(/403/);
  });

  it('dead-letters a row whose lease lapsed with every attempt used (the process died mid-call)', async () => {
    const abandoned = await insertTask('emp-dead', {
      attempts: 5,
      leaseToken: '00000000-0000-4000-8000-000000000001',
      lockedUntil: new Date(Date.now() - 60_000),
    });
    const { relay, reconcile } = makeRelay();

    await relay.relay();

    const row = await load(abandoned.id);
    expect(row.status).toBe('failed');
    expect(row.lastError).toMatch(/abandoned/);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('does not touch a row whose lease is still live', async () => {
    const held = await insertTask('emp-held', {
      attempts: 1,
      leaseToken: '00000000-0000-4000-8000-000000000002',
      lockedUntil: new Date(Date.now() + 5 * 60_000),
    });
    const { relay, reconcile } = makeRelay();

    await relay.relay();

    expect(reconcile).not.toHaveBeenCalled();
    expect((await load(held.id)).status).toBe('pending');
  });

  it('re-claims a row whose lease lapsed with attempts left', async () => {
    const lapsed = await insertTask('emp-lapsed', {
      attempts: 1,
      leaseToken: '00000000-0000-4000-8000-000000000003',
      lockedUntil: new Date(Date.now() - 1_000),
    });
    const { relay, reconcile } = makeRelay();

    await relay.relay();

    expect(reconcile).toHaveBeenCalledWith('emp-lapsed');
    const row = await load(lapsed.id);
    expect(row.status).toBe('sent');
    expect(row.attempts).toBe(2);
  });

  it('THE FENCE: a relay that lost its lease mid-call writes nothing', async () => {
    const task = await insertTask('emp-fenced');
    const takeover = '00000000-0000-4000-8000-0000000000ff';
    const { relay } = makeRelay({
      reconcile: async () => {
        // Another relay claims the row while this one is still calling out.
        await pool.query(`UPDATE messaging.graph_task_outbox SET lease_token = $1 WHERE id = $2`, [
          takeover,
          task.id,
        ]);
      },
    });

    await relay.relay();

    const row = await load(task.id);
    expect(row.status, 'a relay that lost its lease overwrote the new holder').toBe('pending');
    expect(row.leaseToken).toBe(takeover);
    expect(row.sentAt).toBeNull();
  });
});

describe('per-employee ordering, against PostgreSQL', () => {
  it('claims one task per employee at a time, in seq order, and the next only after the first finished', async () => {
    const e1a = await insertTask('e1');
    const e1b = await insertTask('e1');
    const e2 = await insertTask('e2');
    const calls: string[] = [];
    const { relay } = makeRelay({
      reconcile: (employeeId) => {
        calls.push(employeeId);
        return Promise.resolve();
      },
    });

    await relay.relay();
    expect(calls).toEqual(['e1', 'e2']); // e1's SECOND task is held back by its first
    expect((await load(e1b.id)).status).toBe('pending');

    await relay.relay();
    expect(calls).toEqual(['e1', 'e2', 'e1']);
    expect((await load(e1a.id)).status).toBe('sent');
    expect((await load(e1b.id)).status).toBe('sent');
    expect((await load(e2.id)).status).toBe('sent');
  });

  it('holds a later task back while the earlier one is backing off after a failure', async () => {
    const first = await insertTask('e3');
    const second = await insertTask('e3');
    const { relay, reconcile } = makeRelay({ reconcile: () => Promise.reject(new Error('down')) });

    await relay.relay();
    await relay.relay();

    // The first failed and is waiting out its backoff; the second must not leapfrog it.
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect((await load(first.id)).attempts).toBe(1);
    expect((await load(second.id)).attempts).toBe(0);
  });

  it('is not blocked by a dead-lettered earlier task', async () => {
    await insertTask('e4', { status: 'failed', attempts: 5 });
    const later = await insertTask('e4');
    const { relay, reconcile } = makeRelay();

    await relay.relay();

    expect(reconcile).toHaveBeenCalledWith('e4');
    expect((await load(later.id)).status).toBe('sent');
  });
});
