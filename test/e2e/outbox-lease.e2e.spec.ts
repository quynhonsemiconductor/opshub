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
import {
  GraphAccountRelayService,
  GraphScanRelayService,
} from '../../libs/modules/graph/src/application/graph-task-relay.service';
import { GRAPH_TASK } from '../../libs/modules/graph/src/graph-task';
import * as schema from '../../db/schema';
import type { DrizzleDB } from '@platform';

const { graphTaskOutbox } = schema;

let pool: Pool;
let observer: Pool;
let db: DrizzleDB;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface RelayOptions {
  reconcile?: (employeeId: string, leaseExpiresAt: Date) => Promise<void>;
  scan?: () => Promise<unknown>;
  /** The ExclusiveJob lock is held by another run (the cron). */
  lockHeld?: boolean;
}

function makeRelays(options: RelayOptions = {}) {
  const reconcile = vi.fn(options.reconcile ?? (() => Promise.resolve()));
  const detectShadowIt = vi.fn(
    options.scan ?? (() => Promise.resolve({ scanned: 0, newFindings: 0 })),
  );
  const args = [
    db,
    { isEnabled: () => true } as never,
    { reconcile } as never,
    { detectShadowIt } as never,
    { runPostureSync: vi.fn() } as never,
    {
      run: async (_n: string, _t: number, fn: () => Promise<void>) => {
        if (!options.lockHeld) await fn();
      },
    } as never,
  ] as const;
  return {
    relay: new GraphAccountRelayService(...args),
    scanRelay: new GraphScanRelayService(...args),
    reconcile,
    detectShadowIt,
  };
}

/** The account relay, which is what most of these tests are about. */
const makeRelay = (options: RelayOptions = {}) => {
  const { relay, reconcile } = makeRelays(options);
  return { relay, reconcile };
};

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

    expect(reconcile).toHaveBeenCalledWith('emp-lapsed', expect.any(Date));
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
    // The first batch is e1 and e2: e1's SECOND task is held back by its first (it would otherwise sit
    // between them, [e1, e1, e2]) and is claimed by the NEXT batch of the same pass, after e1 finished.
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

    expect(reconcile).toHaveBeenCalledWith('e4', expect.any(Date));
    expect((await load(later.id)).status).toBe('sent');
  });
});

describe('long tasks never hold up account tasks, against PostgreSQL', () => {
  it('AN ACCOUNT TASK COMPLETES WHILE A LONG SCAN IS STILL IN FLIGHT', async () => {
    /*
     * Account reconciles and scans used to share one relay and one serialized pass, so an offboarding
     * disable could wait behind a scan for as long as the scan's lease. They are separate claims now.
     */
    const scanTask = await db
      .insert(graphTaskOutbox)
      .values({
        kind: GRAPH_TASK.SHADOW_IT_SCAN,
        payload: {},
        dedupeKey: GRAPH_TASK.SHADOW_IT_SCAN,
      })
      .returning()
      .then((r) => r[0]);
    const accountTask = await insertTask('e-urgent');

    let releaseScan!: () => void;
    let scanStarted!: () => void;
    const started = new Promise<void>((resolve) => (scanStarted = resolve));
    const { relay, scanRelay } = makeRelays({
      scan: () =>
        new Promise((resolve) => {
          scanStarted();
          releaseScan = () => resolve({ scanned: 0, newFindings: 0 });
        }),
    });

    const scanning = scanRelay.relay(); // claims the scan and blocks inside it
    await started;
    expect((await load(scanTask.id)).leaseToken, 'the scan holds a lease').not.toBeNull();

    await relay.relay(); // the account relay runs NOW, with the scan still in flight
    expect((await load(accountTask.id)).status, 'the account task waited behind the scan').toBe(
      'sent',
    );
    expect((await load(scanTask.id)).status).toBe('pending'); // still running

    releaseScan();
    await scanning;
    expect((await load(scanTask.id)).status).toBe('sent');
  });

  it("a scan is DEFERRED, not finished, when the cron's lock is held: pending, attempt refunded", async () => {
    const task = await db
      .insert(graphTaskOutbox)
      .values({
        kind: GRAPH_TASK.SHADOW_IT_SCAN,
        payload: {},
        dedupeKey: GRAPH_TASK.SHADOW_IT_SCAN,
      })
      .returning()
      .then((r) => r[0]);
    const { scanRelay, detectShadowIt } = makeRelays({ lockHeld: true });
    const before = Date.now();

    await scanRelay.relay();

    const row = await load(task.id);
    expect(detectShadowIt).not.toHaveBeenCalled();
    expect(row.status).toBe('pending');
    expect(row.attempts, 'waiting on a lock must not use up the retry budget').toBe(0);
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(before + 4 * 60_000);
    expect(row.leaseToken).toBeNull();
  });
});

describe('overlap and ordering, against PostgreSQL', () => {
  it('never claims a second task for an employee while another holds a LIVE lease, whatever the seq order', async () => {
    /*
     * Commit order can differ from seq order: T1 (lower seq) is still uncommitted when T2 commits. The
     * relay claims T2; then T1 commits. T1 is "earlier", but T2 is running — they must not overlap.
     */
    const client = await pool.connect();
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO messaging.graph_task_outbox (kind, payload, ordering_key)
       VALUES ('entra.account.reconcile', '{"employeeId":"e-race"}', 'e-race') RETURNING id`,
    );
    const t1 = rows[0].id; // seq allocated, NOT visible yet
    const t2 = (await insertTask('e-race')).id; // higher seq, committed

    let releaseT2!: () => void;
    let t2Started!: () => void;
    const started = new Promise<void>((resolve) => (t2Started = resolve));
    const delivered: string[] = [];
    const { relay: first } = makeRelay({
      reconcile: () =>
        // Only t2's call blocks; the pass drains, and t1 (claimable once t2 is done) goes straight through.
        delivered.length > 0
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              delivered.push('t2');
              t2Started();
              releaseT2 = resolve;
            }),
    });
    const running = first.relay(); // claims t2 and blocks in the call
    await started;

    await client.query('COMMIT'); // t1 becomes visible while t2 is in flight
    client.release();

    const { relay: second, reconcile: secondCalls } = makeRelay();
    await second.relay();
    expect(
      secondCalls,
      'a second task for the same employee ran while one was in flight',
    ).not.toHaveBeenCalled();
    expect((await load(t1)).attempts).toBe(0);

    releaseT2();
    await running; // t2 finishes, then the same pass claims t1
    await second.relay();
    expect((await load(t1)).attempts, 't1 was delivered once').toBe(1);
    expect(secondCalls).not.toHaveBeenCalled();
    expect((await load(t1)).status).toBe('sent');
    expect((await load(t2)).status).toBe('sent');
  });

  it('two relays claiming at the same instant never run two tasks for one employee AT ONCE', async () => {
    for (let i = 0; i < 5; i++) await insertTask('e-concurrent');
    let running = 0;
    let overlapped = false;
    const calls: string[] = [];
    const slow = (employeeId: string) => {
      calls.push(employeeId);
      running += 1;
      if (running > 1) overlapped = true;
      return new Promise<void>((resolve) =>
        setTimeout(() => {
          running -= 1;
          resolve();
        }, 100),
      );
    };
    const a = makeRelay({ reconcile: slow }).relay;
    const b = makeRelay({ reconcile: slow }).relay;
    const c = makeRelay({ reconcile: slow }).relay;

    await Promise.all([a.relay(), b.relay(), c.relay()]);

    expect(overlapped, 'two tasks for one employee were in flight together').toBe(false);
    // Every task ran exactly once, in turn.
    expect(calls).toHaveLength(5);
    const sent = await db.select().from(graphTaskOutbox);
    expect(sent.map((r) => r.status)).toEqual(Array(5).fill('sent'));
    expect(sent.map((r) => r.attempts)).toEqual(Array(5).fill(1));
  });

  it('SERIALIZES CLAIMS: a claim waits for the claim lock, then sees the leases the previous claim stamped', async () => {
    /*
     * Under READ COMMITTED two claim transactions running at once cannot see each other's uncommitted
     * leases. Each claim takes pg_advisory_xact_lock in a statement BEFORE its SELECT, so a second claim
     * waits and its SELECT (a new statement, a new snapshot) sees the first one's committed leases.
     * Modelled by holding that lock from another session.
     */
    const task = await insertTask('e-locked');
    const holder = await pool.connect();
    await holder.query("SELECT pg_advisory_lock(hashtext('messaging.graph_task_outbox:claim'))");
    const { relay, reconcile } = makeRelay();
    let finished = false;
    const running = relay.relay().then(() => (finished = true));
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(finished, 'a claim ran without taking the claim lock').toBe(false);
      expect(reconcile).not.toHaveBeenCalled();
      expect((await load(task.id)).attempts).toBe(0);
    } finally {
      await holder.query(
        "SELECT pg_advisory_unlock(hashtext('messaging.graph_task_outbox:claim'))",
      );
      holder.release();
    }

    await running;
    expect(reconcile).toHaveBeenCalledWith('e-locked', expect.any(Date));
    expect((await load(task.id)).status).toBe('sent');
  });
});

describe('the abandoned-row reaper is scoped to its own relay, against PostgreSQL', () => {
  it('each relay dead-letters only its own kinds', async () => {
    const lapsed = {
      attempts: 5,
      leaseToken: '00000000-0000-4000-8000-0000000000aa',
      lockedUntil: new Date(Date.now() - 60_000),
    };
    const accountRow = await insertTask('e-abandoned', lapsed);
    const scanRow = await db
      .insert(graphTaskOutbox)
      .values({
        kind: GRAPH_TASK.SHADOW_IT_SCAN,
        payload: {},
        dedupeKey: GRAPH_TASK.SHADOW_IT_SCAN,
        ...lapsed,
      })
      .returning()
      .then((r) => r[0]);
    const { relay, scanRelay } = makeRelays();

    await relay.relay(); // the ACCOUNT relay
    expect((await load(accountRow.id)).status).toBe('failed');
    expect((await load(scanRow.id)).status, 'the account relay reaped a scan row').toBe('pending');

    await scanRelay.relay();
    expect((await load(scanRow.id)).status).toBe('failed');
  });
});

describe('deferring on a held lock is bounded, against PostgreSQL', () => {
  const scanRow = (extra: Partial<typeof graphTaskOutbox.$inferInsert> = {}) =>
    db
      .insert(graphTaskOutbox)
      .values({
        kind: GRAPH_TASK.SHADOW_IT_SCAN,
        payload: {},
        dedupeKey: GRAPH_TASK.SHADOW_IT_SCAN,
        ...extra,
      })
      .returning()
      .then((r) => r[0]);

  it('a young request behind a held lock goes back to pending with its attempt refunded', async () => {
    const row = await scanRow();
    const { scanRelay } = makeRelays({ lockHeld: true });

    await scanRelay.relay();

    const after = await load(row.id);
    expect(after.status).toBe('pending');
    expect(after.attempts).toBe(0);
    expect(after.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);
  });

  it('a request that has waited past the lock TTL + margin DEAD-LETTERS (alarm), not defers for ever', async () => {
    const row = await scanRow({ createdAt: new Date(Date.now() - 6 * 3_600_000) });
    const { scanRelay } = makeRelays({ lockHeld: true });

    await scanRelay.relay();

    const after = await load(row.id);
    expect(after.status).toBe('failed');
    expect(after.lastError).toMatch(/stayed held/);
  });
});
