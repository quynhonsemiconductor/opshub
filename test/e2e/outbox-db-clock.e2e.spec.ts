/**
 * The outbox claims and leases run on the DATABASE's clock (the Time rule, .github#29), not the host's.
 *
 * Both tests inject host/DB clock skew with the host's Date (the database keeps its own clock). They fail on a build
 * whose claim compares a lease or a due time with the host:
 *  - the host AHEAD of the database: a live lease that another relay holds must not look lapsed to it;
 *  - the host BEHIND the database: a row the database says is due must be claimed now.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GraphAccountRelayService } from '../../libs/modules/graph/src/application/graph-task-relay.service';
import { GRAPH_TASK } from '../../libs/modules/graph/src/graph-task';
import * as schema from '../../db/schema';
import type { DrizzleDB, DrizzleTx } from '@platform';

const { graphTaskOutbox } = schema;
const HOUR = 60 * 60_000;

let pool: Pool;
let db: DrizzleDB;

function relayArgs(reconcile: (employeeId: string, leaseExpiresAt: Date) => Promise<void>) {
  return [
    db,
    { isEnabled: () => true } as never,
    { reconcile: vi.fn(reconcile) } as never,
    { detectShadowIt: vi.fn() } as never,
    { runPostureSync: vi.fn() } as never,
    { run: async (_n: string, _t: number, fn: () => Promise<void>) => fn() } as never,
  ] as const;
}

function relayWith(reconcile: (employeeId: string, leaseExpiresAt: Date) => Promise<void>) {
  return new GraphAccountRelayService(...relayArgs(reconcile));
}

/**
 * A claim that WAITS inside its transaction before it selects (a lock, a slow beforeSelect). It reads the lease it
 * stamped back, from inside the same transaction: locked_until minus now() (the transaction's start). A lease measured
 * from the statement runs the hold from AFTER that wait; one measured from the transaction start does not.
 */
class SlowClaimRelay extends GraphAccountRelayService {
  readonly waitedMs = 1500;
  target = '';
  observed: { holdMs: number; leftMs: number } | null = null;

  protected override async beforeSelect(tx: DrizzleTx): Promise<void> {
    await tx.execute(sql`select pg_sleep(${this.waitedMs / 1000})`);
  }

  protected override async stampLeases(
    tx: DrizzleTx,
    ids: string[],
    token: string,
    holdMs: number,
  ): Promise<{ attempts: Map<string, number>; leaseExpiresAt: Date }> {
    const result = await super.stampLeases(tx, ids, token, holdMs);
    if (ids.includes(this.target)) {
      const read = await tx.execute<{ left: number | string }>(
        sql`select extract(epoch from (locked_until - now())) * 1000 as left from messaging.graph_task_outbox where id = ${this.target}`,
      );
      this.observed = { holdMs, leftMs: Number(read.rows[0]?.left) };
    }
    return result;
  }
}

async function insertTaskByDatabase(employeeId: string) {
  // No nextAttemptAt: the column default is the DATABASE's now(), the clock the claim now uses.
  const [row] = await db
    .insert(graphTaskOutbox)
    .values({
      kind: GRAPH_TASK.ACCOUNT_RECONCILE,
      payload: { employeeId },
      orderingKey: employeeId,
    })
    .returning();
  return row;
}

beforeAll(() => {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is required');
  pool = new Pool({ connectionString: url, max: 4 });
  db = drizzle(pool, { schema });
});

afterAll(async () => {
  vi.useRealTimers();
  await pool?.end();
});

describe('outbox claims and leases on the database clock', () => {
  it('measures the lease from after the claim waited for its lock, not from the transaction start', async () => {
    const task = await insertTaskByDatabase(`lease-wait-${Date.now()}`);
    const relay = new SlowClaimRelay(...relayArgs(() => Promise.resolve()));
    relay.target = task.id;

    await relay.relay();

    expect(relay.observed, 'the claim never stamped the target row').not.toBeNull();
    const { holdMs, leftMs } = relay.observed!;
    // now() would leave about holdMs; statement_timestamp() leaves about holdMs + the wait. Allow 300 ms of slack.
    expect(
      leftMs,
      'the hold started at the transaction start, before the wait',
    ).toBeGreaterThanOrEqual(holdMs + relay.waitedMs - 300);
  });

  it('does not let a host clock AHEAD of the database take a live lease another relay holds', async () => {
    const employee = `skew-ahead-${Date.now()}`;
    const task = await insertTaskByDatabase(employee);

    // Relay 1 claims the row (its lease is stamped by the database) and is still inside the Graph call.
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => (firstStarted = resolve));
    const first = relayWith(
      () =>
        new Promise<void>((resolve) => {
          firstStarted();
          releaseFirst = resolve;
        }),
    );
    const firstPass = first.relay();
    await started;

    // The host now runs an hour AHEAD. A second relay must still see the lease as live.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + HOUR);
    try {
      const reconcileSecond = vi.fn(() => Promise.resolve());
      const second = relayWith(reconcileSecond);
      await second.relay();
      // Other specs leave due rows in the shared database, so count only THIS task's employee.
      expect(
        reconcileSecond.mock.calls.filter((c: unknown[]) => c[0] === employee),
        'a live lease held by another relay was taken over',
      ).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }

    releaseFirst();
    await firstPass;
    const row = (await db.select().from(graphTaskOutbox).where(eq(graphTaskOutbox.id, task.id)))[0];
    expect(row.status).toBe('sent');
  });

  it('claims a row the database says is due, even when the host clock runs an hour BEHIND', async () => {
    const employee = `skew-behind-${Date.now()}`;
    const task = await insertTaskByDatabase(employee);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() - HOUR);
    try {
      const reconcile = vi.fn(() => Promise.resolve());
      await relayWith(reconcile).relay();
      expect(
        reconcile.mock.calls.filter((c: unknown[]) => c[0] === employee),
        'a row the database had due was not claimed',
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }

    const row = (await db.select().from(graphTaskOutbox).where(eq(graphTaskOutbox.id, task.id)))[0];
    expect(row.status).toBe('sent');
  });
});
