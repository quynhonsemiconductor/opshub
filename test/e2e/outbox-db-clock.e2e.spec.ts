/**
 * The outbox claims and leases run on the DATABASE's clock (the Time rule, .github#29), not the host's.
 *
 * The rows here are moved by SQL intervals against the database's now(), so no test fakes the host clock. The one
 * exception is labelled below: the host runs an hour AHEAD while a live lease is held, the case where a host-clock
 * comparison would wrongly take the row over.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GraphAccountRelayService } from '../../libs/modules/graph/src/application/graph-task-relay.service';
import { GRAPH_TASK } from '../../libs/modules/graph/src/graph-task';
import * as schema from '../../db/schema';
import type { DrizzleDB, DrizzleTx } from '@platform';
import { leaseLeftMs } from '../../libs/modules/graph/src/application/entra-account.service';

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

  it('does not take a row whose lease another relay holds on the database clock', async () => {
    const employee = `lease-held-${Date.now()}`;
    const task = await insertTaskByDatabase(employee);
    // Another relay's lease, stamped by the database: it runs 10 minutes past the database's now().
    await db.execute(
      sql`update messaging.graph_task_outbox
            set lease_token = gen_random_uuid(), locked_until = now() + interval '10 minutes'
          where id = ${task.id}`,
    );

    const reconcile = vi.fn(() => Promise.resolve());
    await relayWith(reconcile).relay();

    expect(
      reconcile.mock.calls.filter((c: unknown[]) => c[0] === employee),
      'a live lease held by another relay was taken over',
    ).toHaveLength(0);
  });

  it('claims a row the database says is due, once its lease has lapsed', async () => {
    const employee = `lease-lapsed-${Date.now()}`;
    const task = await insertTaskByDatabase(employee);
    // A lease that ended a minute ago, by the database's clock.
    await db.execute(
      sql`update messaging.graph_task_outbox
            set lease_token = gen_random_uuid(), locked_until = now() - interval '1 minute'
          where id = ${task.id}`,
    );

    const reconcile = vi.fn(() => Promise.resolve());
    await relayWith(reconcile).relay();

    expect(
      reconcile.mock.calls.filter((c: unknown[]) => c[0] === employee),
      'a row whose lease the database had lapsed was not claimed',
    ).toHaveLength(1);
    const row = (await db.select().from(graphTaskOutbox).where(eq(graphTaskOutbox.id, task.id)))[0];
    expect(row.status).toBe('sent');
  });

  it('reads the lease time left from the DATABASE through the real Graph lease SQL', async () => {
    const { rows } = await db.execute<{ at: Date }>(sql`select now() + interval '2 minutes' as at`);

    const left = await leaseLeftMs(db, rows[0].at);
    expect(left).toBeGreaterThan(110_000);
    expect(left).toBeLessThanOrEqual(120_000);
  });

  it('schedules a retry 30 s out on the database clock', async () => {
    const employee = `retry-due-${Date.now()}`;
    const task = await insertTaskByDatabase(employee);

    await relayWith(() => Promise.reject(new Error('graph is down'))).relay();

    const row = (await db.select().from(graphTaskOutbox).where(eq(graphTaskOutbox.id, task.id)))[0];
    expect(row.status).toBe('pending');
    // The first retry is 30 s after the DATABASE's now(), measured by the database itself.
    const left = await db.execute<{ left: number | string }>(
      sql`select extract(epoch from (next_attempt_at - now())) as left from messaging.graph_task_outbox where id = ${task.id}`,
    );
    expect(Number(left.rows[0]?.left)).toBeGreaterThan(20);
    expect(Number(left.rows[0]?.left)).toBeLessThan(40);
  });

  it('DELIBERATE HOST-SKEW EXCEPTION: a host clock an hour AHEAD does not take a live lease another relay holds', async () => {
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
      await relayWith(reconcileSecond).relay();
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
});
