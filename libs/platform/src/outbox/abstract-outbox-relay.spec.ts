/**
 * AbstractOutboxRelay unit tests — the shared lease-and-fence relay loop: pass coalescing, no transaction
 * open across the external call, fencing on the lease, attempts spent at claim, retry/backoff, terminal
 * 'failed' status, and the dead-letter field the CloudWatch alarm matches. Every concrete relay (email,
 * notifications, webhooks, Graph tasks) inherits this, so covering it once here covers all four.
 *
 * The SQL of the lease steps (claim, fence, reap) is exercised against a real PostgreSQL in
 * test/e2e/outbox-lease.e2e.spec.ts; here those steps are replaced so the LOOP is tested in isolation.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  AbstractOutboxRelay,
  DEAD_LETTER_FIELD,
  DeferError,
  MAX_RETRY_AFTER_MS,
  NonRetryableError,
  RetryAfterError,
  type Claimed,
  type OutboxLeaseTable,
  type PostCommitTask,
} from './abstract-outbox-relay';
import type { DrizzleDB, DrizzleTx } from '../database/drizzle.provider';

interface TestRow {
  id: string;
  /** Attempts BEFORE the claim; the claim spends one. */
  attempts: number;
  /** What `deliver` does. */
  deliver?:
    | 'ok'
    | 'fail'
    | 'non-retryable'
    | 'retry-after'
    | 'huge-retry-after'
    | 'bad-retry-after'
    | 'defer'
    | 'slow';
  /** `settle` throws (a database error in the finish transaction). */
  settleFails?: boolean;
  postCommit?: PostCommitTask;
}

/** Counts open transactions, so a test can assert none is open while `deliver` runs. */
function makeFakeDb() {
  const state = { open: 0, maxOpen: 0, commits: 0 };
  const db = {
    transaction: async (cb: (tx: DrizzleTx) => Promise<unknown>) => {
      state.open += 1;
      state.maxOpen = Math.max(state.maxOpen, state.open);
      try {
        const result = await cb({} as DrizzleTx);
        state.commits += 1;
        return result;
      } finally {
        state.open -= 1;
      }
    },
  } as unknown as DrizzleDB;
  return { db, state };
}

class TestRelay extends AbstractOutboxRelay<TestRow, string> {
  private due: TestRow[] = [];
  private readonly byId = new Map<string, TestRow>();
  openDuringDeliver: number[] = [];
  delivered: string[] = [];
  sent: Array<{ id: string; result: string }> = [];
  failed: Array<{
    id: string;
    attempts: number;
    status: 'pending' | 'failed';
    error: string;
    nextAttemptAt: Date;
  }> = [];
  stampedAttempts = new Map<string, number>();
  reaped = 0;
  /** Ids whose lease another relay holds by the time this one tries to finish. */
  lostAtFinish = new Set<string>();
  /** Ids whose lease was already gone when this relay tried to renew it. */
  lostAtRenew = new Set<string>();
  markFailedThrows = false;
  refunded: string[] = [];

  constructor(
    db: DrizzleDB,
    private readonly txState: { open: number },
  ) {
    super(db);
  }

  protected readonly outbox = {} as OutboxLeaseTable;

  /** Queue rows for the next claim. */
  load(rows: TestRow[]): void {
    for (const r of rows) this.byId.set(r.id, r);
    this.due = rows;
  }

  /** More batches for the same pass: each claim takes the next one. */
  queuedBatches: TestRow[][] = [];

  protected selectDue(): Promise<TestRow[]> {
    this.claims += 1;
    const rows = this.due;
    this.due = this.queuedBatches.shift() ?? [];
    for (const r of this.due) this.byId.set(r.id, r);
    return Promise.resolve(rows);
  }

  protected reapAbandoned(): Promise<number> {
    return Promise.resolve(this.reaped);
  }

  /** The claim spends an attempt on each row. */
  protected stampLeases(
    _tx: DrizzleTx,
    ids: string[],
    _token: string,
    lockedUntil: Date,
  ): Promise<Map<string, number>> {
    const map = new Map(ids.map((id) => [id, this.byId.get(id)!.attempts + 1]));
    this.stampedAttempts = map;
    this.heldUntil.push(lockedUntil);
    return Promise.resolve(map);
  }

  /** The `locked_until` each claim stamped. */
  heldUntil: Date[] = [];
  /** How long each row's lease is (default 10 s). */
  leaseMs = 10_000;
  claims = 0;
  beforeSelectCalls = 0;

  protected leaseMsFor(): number {
    return this.leaseMs;
  }

  /** How long the claim lock takes to acquire. */
  beforeSelectWaitMs = 0;

  protected async beforeSelect(): Promise<void> {
    this.beforeSelectCalls += 1;
    if (this.beforeSelectWaitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.beforeSelectWaitMs));
    }
  }

  protected renewLease(row: Claimed<TestRow>): Promise<Date | null> {
    return Promise.resolve(
      this.lostAtRenew.has(row.id) ? null : new Date(Date.now() + this.leaseMs),
    );
  }

  protected holdsLease(_tx: DrizzleTx, row: Claimed<TestRow>): Promise<boolean> {
    return Promise.resolve(!this.lostAtFinish.has(row.id));
  }

  protected refundAttempt(_tx: DrizzleTx, row: Claimed<TestRow>): Promise<void> {
    this.refunded.push(row.id);
    return Promise.resolve();
  }

  protected releaseLease(): Promise<void> {
    return Promise.resolve();
  }

  protected async deliver(row: Claimed<TestRow>): Promise<string> {
    this.openDuringDeliver.push(this.txState.open);
    this.delivered.push(row.id);
    switch (this.byId.get(row.id)?.deliver) {
      case 'fail':
        throw new Error(`row ${row.id} failed`);
      case 'non-retryable':
        throw new NonRetryableError(`row ${row.id} is malformed`);
      case 'retry-after':
        throw new RetryAfterError(`row ${row.id} throttled`, 5 * 60_000);
      case 'huge-retry-after':
        throw new RetryAfterError('throttled for ever', 1e13 * 1000);
      case 'bad-retry-after':
        throw new RetryAfterError('throttled by NaN', Number.NaN);
      case 'defer':
        throw new DeferError('another run holds the lock', 5 * 60_000);
      case 'slow':
        await new Promise((resolve) => setTimeout(resolve, 5));
        return `msg-${row.id}`;
      default:
        return `msg-${row.id}`;
    }
  }

  protected settle(row: Claimed<TestRow>): Promise<PostCommitTask | void> {
    const spec = this.byId.get(row.id);
    if (spec?.settleFails) return Promise.reject(new Error('settle failed'));
    return Promise.resolve(spec?.postCommit);
  }

  protected markSent(_tx: DrizzleTx, row: Claimed<TestRow>, result: string): Promise<void> {
    this.sent.push({ id: row.id, result });
    return Promise.resolve();
  }

  protected markFailed(
    _tx: DrizzleTx,
    row: Claimed<TestRow>,
    status: 'pending' | 'failed',
    error: string,
    nextAttemptAt: Date,
  ): Promise<void> {
    if (this.markFailedThrows) return Promise.reject(new Error('could not record the failure'));
    this.failed.push({ id: row.id, attempts: row.attempts, status, error, nextAttemptAt });
    return Promise.resolve();
  }
}

function make() {
  const { db, state } = makeFakeDb();
  const relay = new TestRelay(db, state);
  return { relay, state };
}

const backoff = (relay: TestRelay, n: number) =>
  (relay as unknown as { backoffDelayMs(n: number): number }).backoffDelayMs(n);

describe('AbstractOutboxRelay.backoffDelayMs()', () => {
  it('doubles the delay per attempt starting at 30s, capped at 30 minutes', () => {
    const { relay } = make();
    expect(backoff(relay, 1)).toBe(30_000);
    expect(backoff(relay, 2)).toBe(60_000);
    expect(backoff(relay, 3)).toBe(120_000);
    expect(backoff(relay, 4)).toBe(240_000);
    expect(backoff(relay, 5)).toBe(480_000);
    expect(backoff(relay, 20)).toBe(30 * 60_000);
  });
});

describe('AbstractOutboxRelay — no transaction across the external call', () => {
  it('delivers with NO transaction open, and finishes in its own short one', async () => {
    /*
     * THE DEFECT. The relay used to keep one transaction (and its row locks) open for the whole batch
     * while it called the external system. The runtime role has idle_in_transaction_session_timeout, so
     * a slow call got the SESSION killed — the batch rolled back with its attempt counters, nothing
     * dead-lettered, and the loop was silent.
     */
    const { relay, state } = make();
    relay.load([
      { id: 'a', attempts: 0, deliver: 'slow' },
      { id: 'b', attempts: 0 },
    ]);

    await relay.relay();

    expect(relay.openDuringDeliver).toEqual([0, 0]);
    expect(relay.sent.map((s) => s.id)).toEqual(['a', 'b']);
    // One claim, one finish per row, and the empty claim that ends the pass; never more than one open.
    expect(state.commits).toBe(4);
    expect(state.maxOpen).toBe(1);
  });

  it('hands the delivery result to markSent', async () => {
    const { relay } = make();
    relay.load([{ id: 'a', attempts: 0 }]);
    await relay.relay();
    expect(relay.sent).toEqual([{ id: 'a', result: 'msg-a' }]);
  });
});

describe('AbstractOutboxRelay — attempts are spent at claim', () => {
  it('counts the claim as an attempt, so markFailed sees attempt 1 on the first failure', async () => {
    const { relay } = make();
    relay.load([{ id: 'a', attempts: 0, deliver: 'fail' }]);
    const before = Date.now();

    await relay.relay();

    expect(relay.failed).toHaveLength(1);
    const call = relay.failed[0];
    expect(call.attempts).toBe(1);
    expect(call.status).toBe('pending');
    // attempt 1 -> ~30s. Immediate retry is the defect backoff replaced: five of them fit inside a
    // brief outage and the fifth dead-letters the row for good.
    expect(call.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 29_000);
    expect(call.nextAttemptAt.getTime()).toBeLessThanOrEqual(before + 31_000);
  });

  it('dead-letters once the claimed attempt is the last one', async () => {
    const { relay } = make();
    relay.load([{ id: 'a', attempts: 4, deliver: 'fail' }]); // claim makes it the 5th == maxAttempts

    await relay.relay();

    expect(relay.failed[0]).toMatchObject({ attempts: 5, status: 'failed' });
  });

  it('reaps abandoned rows (lease lapsed with every attempt used) at the start of every claim', async () => {
    const { relay } = make();
    relay.reaped = 2;
    const logged = vi.spyOn(
      (relay as unknown as { logger: { error: (...a: unknown[]) => void } }).logger,
      'error',
    );

    await relay.relay();

    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0][0]).toMatchObject({
      abandoned: 2,
      [DEAD_LETTER_FIELD]: 'TestRelay',
    });
  });
});

describe('AbstractOutboxRelay — failure classification', () => {
  it('dead-letters a NonRetryableError on the first attempt', async () => {
    const { relay } = make();
    relay.load([{ id: 'a', attempts: 0, deliver: 'non-retryable' }]);

    await relay.relay();

    expect(relay.failed[0]).toMatchObject({ attempts: 1, status: 'failed' });
    expect(relay.failed[0].error).toMatch(/malformed/);
  });

  it('honours Retry-After when it is longer than the backoff', async () => {
    const { relay } = make();
    relay.load([{ id: 'a', attempts: 0, deliver: 'retry-after' }]);
    const before = Date.now();

    await relay.relay();

    expect(relay.failed[0].status).toBe('pending');
    expect(relay.failed[0].nextAttemptAt.getTime()).toBeGreaterThanOrEqual(
      before + 5 * 60_000 - 1_000,
    );
  });
});

describe('AbstractOutboxRelay — Retry-After is clamped, never an Invalid Date', () => {
  it('clamps a huge hint to the maximum', async () => {
    const { relay } = make();
    relay.load([{ id: 'a', attempts: 0, deliver: 'huge-retry-after' }]);
    const before = Date.now();

    await relay.relay();

    const at = relay.failed[0].nextAttemptAt;
    expect(Number.isNaN(at.getTime())).toBe(false);
    expect(at.getTime()).toBeLessThanOrEqual(before + MAX_RETRY_AFTER_MS + 2_000);
    expect(at.getTime()).toBeGreaterThanOrEqual(before + MAX_RETRY_AFTER_MS - 2_000);
  });

  it('falls back to ordinary backoff for a non-finite hint, and still records the failure', async () => {
    const { relay } = make();
    relay.load([{ id: 'a', attempts: 0, deliver: 'bad-retry-after' }]);
    const before = Date.now();

    await relay.relay();

    expect(relay.failed).toHaveLength(1);
    const at = relay.failed[0].nextAttemptAt.getTime();
    expect(Number.isNaN(at)).toBe(false);
    expect(at).toBeGreaterThanOrEqual(before + 29_000);
    expect(at).toBeLessThanOrEqual(before + 31_000);
  });
});

describe('AbstractOutboxRelay — DeferError is not an attempt', () => {
  it('puts the row back to pending and REFUNDS the attempt (the BOUND on deferring belongs to the caller)', async () => {
    const { relay } = make();
    relay.load([{ id: 'a', attempts: 4, deliver: 'defer' }]); // the claim makes it the 5th (the last)
    const before = Date.now();

    await relay.relay();

    expect(relay.refunded).toEqual(['a']);
    expect(relay.failed[0]).toMatchObject({ id: 'a', status: 'pending', attempts: 4 });
    expect(relay.failed[0].nextAttemptAt.getTime()).toBeGreaterThanOrEqual(
      before + 5 * 60_000 - 1_000,
    );
    expect(relay.sent).toEqual([]);
  });

  it('logs every defer at WARN, so a row stuck waiting is visible', async () => {
    const { relay } = make();
    relay.load([{ id: 'a', attempts: 0, deliver: 'defer' }]);
    const warn = vi.spyOn(
      (relay as unknown as { logger: { warn: (...a: unknown[]) => void } }).logger,
      'warn',
    );

    await relay.relay();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][1])).toMatch(/deferred a row for 300 s/);
  });
});

describe('AbstractOutboxRelay — a batch is held for the SUM of its leases', () => {
  it("stamps locked_until = now + the sum of the rows' leases, because they are worked one after another", async () => {
    const { relay } = make();
    relay.leaseMs = 90_000;
    relay.load([
      { id: 'a', attempts: 0 },
      { id: 'b', attempts: 0 },
      { id: 'c', attempts: 0 },
    ]);
    const before = Date.now();

    await relay.relay();

    // Three rows x 90 s = 270 s. A hold of ONE lease (90 s) would lapse while the third row waits behind
    // the first two, and another relay would re-claim it and burn an attempt.
    const held = relay.heldUntil[0].getTime() - before;
    expect(held).toBeGreaterThanOrEqual(270_000 - 1_000);
    expect(held).toBeLessThanOrEqual(270_000 + 2_000);
  });

  it('measures the hold from AFTER the claim lock was acquired, so waiting for it does not shorten the hold', async () => {
    const { relay } = make();
    relay.leaseMs = 90_000;
    relay.beforeSelectWaitMs = 300;
    relay.load([{ id: 'a', attempts: 0 }]);
    const before = Date.now();

    await relay.relay();

    // Without the fix the hold was stamped from a `now` taken before the wait: ~90 s from `before`.
    const held = relay.heldUntil[0].getTime() - before;
    expect(held).toBeGreaterThanOrEqual(90_000 + 250);
  });

  it('keeps claiming until the queue is empty, so small batches cost no throughput', async () => {
    const { relay } = make();
    relay.load([{ id: 'a', attempts: 0 }]);
    relay.queuedBatches = [[{ id: 'b', attempts: 0 }], [{ id: 'c', attempts: 0 }]];

    await relay.relay();

    expect(relay.sent.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(relay.claims).toBe(4); // three batches, then the empty one that ends the pass
  });

  it('runs beforeSelect in every claim, ahead of the SELECT', async () => {
    const { relay } = make();
    relay.load([{ id: 'a', attempts: 0 }]);
    await relay.relay();
    expect(relay.beforeSelectCalls).toBe(relay.claims);
  });

  it('hands each delivery the lease expiry it was just renewed to', async () => {
    const { relay } = make();
    relay.leaseMs = 45_000;
    relay.load([{ id: 'a', attempts: 0 }]);
    const seen: number[] = [];
    (relay as unknown as { deliver: (row: Claimed<TestRow>) => Promise<string> }).deliver = (
      row,
    ) => {
      seen.push(row.leaseExpiresAt.getTime() - Date.now());
      return Promise.resolve('x');
    };

    await relay.relay();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeGreaterThan(40_000);
    expect(seen[0]).toBeLessThanOrEqual(45_000);
  });
});

describe('AbstractOutboxRelay — the fence', () => {
  it('writes nothing when the lease was lost before delivering', async () => {
    const { relay } = make();
    relay.load([{ id: 'a', attempts: 0 }]);
    relay.lostAtRenew.add('a');

    await relay.relay();

    expect(relay.delivered).toEqual([]);
    expect(relay.sent).toEqual([]);
    expect(relay.failed).toEqual([]);
  });

  it('writes nothing when another relay took the row during a slow delivery', async () => {
    /*
     * The lease lapsed while the call was in flight and a second relay claimed the row. The first
     * relay's late `sent` would overwrite whatever the second one decided; the fence makes it a no-op.
     */
    const { relay } = make();
    relay.load([{ id: 'a', attempts: 0, deliver: 'slow' }]);
    relay.lostAtFinish.add('a');

    await relay.relay();

    expect(relay.delivered).toEqual(['a']);
    expect(relay.sent).toEqual([]);
    expect(relay.failed).toEqual([]);
  });

  it('does not record a failure over a row it no longer holds', async () => {
    const { relay } = make();
    relay.load([{ id: 'a', attempts: 0, deliver: 'fail' }]);
    relay.lostAtFinish.add('a');

    await relay.relay();

    expect(relay.failed).toEqual([]);
  });
});

describe('AbstractOutboxRelay — one row never takes the others down', () => {
  it('a failing row does not block the ones behind it', async () => {
    const { relay } = make();
    relay.load([
      { id: 'bad', attempts: 0, deliver: 'fail' },
      { id: 'good', attempts: 0 },
    ]);

    await relay.relay();

    expect(relay.sent.map((s) => s.id)).toEqual(['good']);
    expect(relay.failed.map((f) => f.id)).toEqual(['bad']);
  });

  it('a settle (database) error in the finish transaction is recorded as a failure, and the batch goes on', async () => {
    const { relay } = make();
    relay.load([
      { id: 'poison', attempts: 0, settleFails: true },
      { id: 'behind', attempts: 0 },
    ]);

    await relay.relay();

    expect(relay.sent.map((s) => s.id)).toEqual(['behind']);
    expect(relay.failed.map((f) => f.id)).toEqual(['poison']);
    expect(relay.failed[0].attempts).toBe(1);
  });

  it('keeps going when even recording the failure fails', async () => {
    const { relay } = make();
    relay.markFailedThrows = true;
    relay.load([
      { id: 'unrecordable', attempts: 0, deliver: 'fail' },
      { id: 'after', attempts: 0 },
    ]);

    await relay.relay();

    expect(
      relay.sent.map((s) => s.id),
      'a failed markFailed swallowed the rest of the batch',
    ).toEqual(['after']);
  });

  it('runs a post-commit task only after the finish transaction committed', async () => {
    const { relay, state } = make();
    const seenOpen: number[] = [];
    const commitsAtRun: number[] = [];
    relay.load([
      {
        id: 'a',
        attempts: 0,
        postCommit: () => {
          seenOpen.push(state.open);
          commitsAtRun.push(state.commits);
          return Promise.resolve();
        },
      },
    ]);

    await relay.relay();
    await new Promise((resolve) => setImmediate(resolve));

    expect(seenOpen).toEqual([0]);
    expect(commitsAtRun).toEqual([2]); // claim + finish (the empty claim that ends the pass comes later)
  });
});

describe('AbstractOutboxRelay — pass coalescing', () => {
  it('coalesces racing calls into exactly one extra pass the callers await directly', async () => {
    const { relay } = make();
    let releaseFirst!: () => void;
    let selects = 0;
    const original = (relay as unknown as { selectDue(): Promise<TestRow[]> }).selectDue.bind(
      relay,
    );
    vi.spyOn(
      relay as unknown as { selectDue(): Promise<TestRow[]> },
      'selectDue',
    ).mockImplementation(async () => {
      selects += 1;
      if (selects === 1) await new Promise<void>((resolve) => (releaseFirst = resolve));
      return original();
    });

    const first = relay.relay();
    const second = relay.relay();
    const third = relay.relay();
    const fourth = relay.relay();
    await new Promise((resolve) => setImmediate(resolve)); // let the first pass reach its select
    releaseFirst();
    await Promise.all([first, second, third, fourth]);

    expect(selects).toBe(2); // the in-flight pass + one coalesced extra, not four
  });

  it('a write made just before a racing relay() call is visible to the pass it resolves on', async () => {
    const { relay } = make();
    let releaseFirst!: () => void;
    vi.spyOn(
      relay as unknown as { selectDue(): Promise<TestRow[]> },
      'selectDue',
    ).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => (releaseFirst = resolve));
      return [];
    });

    const first = relay.relay();
    relay.load([{ id: 'written-during-first-pass', attempts: 0 }]);
    const second = relay.relay();
    await new Promise((resolve) => setImmediate(resolve));
    releaseFirst();
    await Promise.all([first, second]);

    expect(relay.sent.map((s) => s.id)).toContain('written-during-first-pass');
  });
});

describe('DEAD_LETTER_FIELD', () => {
  it('uses the field name the infra actually filters on', () => {
    // Guards the rename: the alarm is worthless if the field drifts away from the pattern.
    expect(DEAD_LETTER_FIELD).toBe('outboxDeadLetter');

    // Searches the whole infra tree rather than naming a file, for the same reason
    // fail-open.spec.ts does: asserting on a path needs editing every time the Terraform is
    // reorganised, which is how a guard quietly stops guarding. What matters is that SOME
    // Terraform in this repo filters on the field the app emits.
    const infra = join(__dirname, '../../../..', 'infra');
    // --exclude-dir is not optional: .terraform holds cached provider binaries and module
    // copies, and scanning them blows the test timeout.
    const terraform = execFileSync(
      'grep',
      ['-rl', '--include=*.tf', '--exclude-dir=.terraform', `$.${DEAD_LETTER_FIELD}`, infra],
      { encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean);

    expect(
      terraform,
      `No Terraform under infra/ filters on ${DEAD_LETTER_FIELD}; a relay can exhaust its ` +
        `retries and lose work with nothing alarming, even though the app emits the field.`,
    ).not.toEqual([]);
  });
});
