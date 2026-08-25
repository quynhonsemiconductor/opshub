/**
 * AbstractOutboxRelay unit tests — the shared relay loop (pass coalescing, per-row error
 * handling, retry/backoff, terminal 'failed' status, and the dead-letter field the CloudWatch
 * alarm matches). All four concrete relays inherit this behaviour — email, notifications,
 * webhook deliveries and the SQS outbox — so covering it once here covers all four.
 *
 * Ported from rally along with the backoff and metrics this file exercises. opshub had none
 * of it: the base class shipped with no spec at all, which is how a relay could burn its
 * whole retry budget in 25 seconds without a test noticing.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  AbstractOutboxRelay,
  DEAD_LETTER_FIELD,
  type PostCommitTask,
} from './abstract-outbox-relay';
import type { DrizzleDB, DrizzleTx } from '../database/drizzle.provider';

interface TestRow {
  id: string;
  attempts: number;
  shouldFail: boolean;
  /**
   * Fails the way a DATABASE fails: the statement errors AND the transaction is left aborted.
   *
   * The distinction is the whole point. A row that throws in application code leaves the
   * transaction usable; a row that violates a constraint does not, and Postgres then refuses every
   * subsequent statement — including the one that records the failure.
   */
  abortsTransaction?: boolean;
}

/** Minimal concrete relay exposing hooks the tests can assert against. */
class TestRelay extends AbstractOutboxRelay<TestRow> {
  fetchBatchResult: TestRow[] = [];
  markFailedCalls: Array<{
    rowId: string;
    newAttempts: number;
    newStatus: 'pending' | 'failed';
    nextAttemptAt: Date;
  }> = [];
  markSentCalls: string[] = [];
  /** Makes `markFailed` itself fail, for the "even recording the failure fails" case. */
  markFailedThrows = false;

  // Not `async`: opshub's eslint enforces @typescript-eslint/require-await, and a stub with
  // nothing to await would need a disable comment on each one.
  protected fetchBatch(): Promise<TestRow[]> {
    return Promise.resolve(this.fetchBatchResult);
  }

  protected processRow(row: TestRow, tx: DrizzleTx): Promise<PostCommitTask | void> {
    if (row.abortsTransaction) {
      // Order matters, and it is the order Postgres uses: the transaction is poisoned first, then
      // the caller learns about it.
      (tx as unknown as { fail(): void }).fail();
      return Promise.reject(new Error(`row ${row.id} violated a constraint`));
    }
    return row.shouldFail ? Promise.reject(new Error(`row ${row.id} failed`)) : Promise.resolve();
  }

  protected markSent(tx: DrizzleTx, rowId: string): Promise<void> {
    // Every statement goes through the handle, so an aborted transaction is felt here as it would be.
    (tx as unknown as { assertUsable(): void }).assertUsable();
    this.markSentCalls.push(rowId);
    return Promise.resolve();
  }

  protected markFailed(
    tx: DrizzleTx,
    rowId: string,
    newAttempts: number,
    newStatus: 'pending' | 'failed',
    _lastError: string,
    nextAttemptAt: Date,
  ): Promise<void> {
    (tx as unknown as { assertUsable(): void }).assertUsable();
    if (this.markFailedThrows) return Promise.reject(new Error('could not record the failure'));
    this.markFailedCalls.push({ rowId, newAttempts, newStatus, nextAttemptAt });
    return Promise.resolve();
  }
}

/**
 * A transaction double that MODELS THE ABORT, because the abort is the behaviour under test.
 *
 * The old double was `transaction: (cb) => cb({})` — a callback runner with no notion of a
 * transaction at all. Under it, "one failing row in a batch does not block the others" passed while
 * the real behaviour was a permanently stalled queue: a row failing for a DATABASE reason left
 * Postgres refusing every subsequent statement, so `markFailed` in the catch threw too, the throw
 * escaped the transaction, and the whole batch rolled back — including rows already marked sent, and
 * including the attempt counter that would eventually have dead-lettered the poison row.
 *
 * So this double does what Postgres does: once a statement inside the transaction has failed, any
 * further statement on the SAME handle throws "current transaction is aborted" until something rolls
 * back. `transaction()` on a handle opens a SAVEPOINT — a child handle whose failure marks only
 * itself aborted, and whose rollback leaves the parent usable.
 *
 * Without this, the fix and the bug are indistinguishable from the test's point of view.
 */
function makeTxHandle(parent?: { aborted: boolean }): DrizzleTx & { aborted: boolean } {
  const state = { aborted: false };
  const handle = {
    get aborted() {
      return state.aborted;
    },
    /** Every statement a relay runs goes through here in the tests. */
    assertUsable() {
      if (state.aborted || parent?.aborted) {
        throw new Error(
          'current transaction is aborted, commands ignored until end of transaction block',
        );
      }
    },
    fail() {
      state.aborted = true;
    },
    /*
     * A SAVEPOINT. The child gets its own abort flag, so a statement that fails inside it poisons
     * only the child — and because the child is discarded on the way out, the parent is left usable.
     * That asymmetry IS the fix under test: with one shared flag, a row failure would abort the whole
     * batch exactly as it did in production.
     */
    async transaction(cb: (child: DrizzleTx) => Promise<unknown>) {
      return cb(makeTxHandle(state));
    },
  };
  return handle as unknown as DrizzleTx & { aborted: boolean };
}

function makeFakeDb(): DrizzleDB {
  return {
    transaction: async (cb: (tx: DrizzleTx) => Promise<void>) => cb(makeTxHandle()),
  } as unknown as DrizzleDB;
}

describe('AbstractOutboxRelay.backoffDelayMs()', () => {
  it('doubles the delay per attempt starting at 30s, capped at 30 minutes', () => {
    const relay = new TestRelay(makeFakeDb());
    const delayFor = (n: number) =>
      (relay as unknown as { backoffDelayMs(n: number): number }).backoffDelayMs(n);

    expect(delayFor(1)).toBe(30_000); // 30s
    expect(delayFor(2)).toBe(60_000); // 1m
    expect(delayFor(3)).toBe(120_000); // 2m
    expect(delayFor(4)).toBe(240_000); // 4m
    expect(delayFor(5)).toBe(480_000); // 8m
    // Cap: a hypothetically larger maxAttempts must never exceed 30 minutes.
    expect(delayFor(20)).toBe(30 * 60_000);
  });
});

describe('AbstractOutboxRelay.relay() — retry/backoff wiring', () => {
  it('passes an increasing nextAttemptAt to markFailed on each failed attempt', async () => {
    const relay = new TestRelay(makeFakeDb());
    relay.fetchBatchResult = [{ id: 'row-1', attempts: 0, shouldFail: true }];

    const before = Date.now();
    await relay.relay();

    expect(relay.markFailedCalls).toHaveLength(1);
    const call = relay.markFailedCalls[0];
    expect(call.rowId).toBe('row-1');
    expect(call.newAttempts).toBe(1);
    expect(call.newStatus).toBe('pending');
    // attempt 1 → ~30s delay. Immediate retry is the defect this replaced: five of them
    // fit inside a brief outage, and the fifth dead-letters the row for good.
    expect(call.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 29_000);
    expect(call.nextAttemptAt.getTime()).toBeLessThanOrEqual(before + 31_000);
  });

  it('marks the row terminally failed once attempts reach maxAttempts', async () => {
    const relay = new TestRelay(makeFakeDb());
    // 5th attempt == maxAttempts
    relay.fetchBatchResult = [{ id: 'row-1', attempts: 4, shouldFail: true }];

    await relay.relay();

    expect(relay.markFailedCalls[0].newStatus).toBe('failed');
    expect(relay.markFailedCalls[0].newAttempts).toBe(5);
  });

  it('marks a successful row sent and does not call markFailed for it', async () => {
    const relay = new TestRelay(makeFakeDb());
    relay.fetchBatchResult = [{ id: 'row-ok', attempts: 0, shouldFail: false }];

    await relay.relay();

    expect(relay.markSentCalls).toEqual(['row-ok']);
    expect(relay.markFailedCalls).toHaveLength(0);
  });

  it('one failing row in a batch does not block the others', async () => {
    const relay = new TestRelay(makeFakeDb());
    relay.fetchBatchResult = [
      { id: 'row-bad', attempts: 0, shouldFail: true },
      { id: 'row-good', attempts: 0, shouldFail: false },
    ];

    await relay.relay();

    expect(relay.markSentCalls).toEqual(['row-good']);
    expect(relay.markFailedCalls.map((c) => c.rowId)).toEqual(['row-bad']);
  });

  it('a row that ABORTS THE TRANSACTION does not take the batch with it', async () => {
    /*
     * THE FAILURE THIS FILE COULD NOT SEE. The test above — "one failing row in a batch does not
     * block the others" — passed for years against a relay where this was untrue, because its
     * failing row threw in application code and left the transaction usable. Almost no real failure
     * looks like that: a constraint violation, a value too long, a deleted foreign key all leave
     * Postgres refusing every further statement.
     *
     * What happened then: `markFailed` in the catch was the next statement, so it threw too. That
     * throw escaped the catch, propagated out of the transaction callback, and rolled back the whole
     * batch — the rows already marked sent, and the poison row's attempt counter with them. The next
     * poll fetched the same batch and did it again. The queue stalled permanently, and because no
     * attempt was ever recorded the row never reached `maxAttempts`, so the dead-letter alarm that
     * exists to catch exactly this stayed silent.
     *
     * Found in an e2e run where three notification-email tests failed only in the full suite: an
     * unrelated spec had queued a malformed notification first, and it blocked everything behind it.
     */
    const relay = new TestRelay(makeFakeDb());
    relay.fetchBatchResult = [
      { id: 'row-poison', attempts: 0, shouldFail: true, abortsTransaction: true },
      { id: 'row-behind-it', attempts: 0, shouldFail: false },
    ];

    // Must not throw: a poison row is a row-level event, not a pass-level one.
    await relay.relay();

    // The row behind the poison one still went out. This is the assertion that fails without the
    // per-row savepoint, and it is the one that matters — a stalled queue is invisible until
    // somebody asks why an email never arrived.
    expect(relay.markSentCalls).toEqual(['row-behind-it']);
    // And the poison row's attempt was RECORDED, so it can eventually dead-letter rather than
    // blocking the queue for ever.
    expect(relay.markFailedCalls.map((c) => c.rowId)).toEqual(['row-poison']);
    expect(relay.markFailedCalls[0]?.newAttempts).toBe(1);
  });

  it('keeps going when even recording the failure fails', async () => {
    /*
     * The last line of defence. If the row is gone, or the error text violates something itself,
     * `markFailed` can fail on its own account — and the batch must still finish. Modelled by
     * aborting the transaction and giving the relay a row whose failure cannot be recorded.
     */
    const relay = new TestRelay(makeFakeDb());
    relay.markFailedThrows = true;
    relay.fetchBatchResult = [
      { id: 'row-unrecordable', attempts: 0, shouldFail: true },
      { id: 'row-after', attempts: 0, shouldFail: false },
    ];

    await relay.relay();

    expect(relay.markSentCalls, 'a failed markFailed swallowed the rest of the batch').toEqual([
      'row-after',
    ]);
  });

  it('coalesces racing calls into exactly one extra pass the callers await directly', async () => {
    const relay = new TestRelay(makeFakeDb());
    let resolveFirstFetch!: () => void;
    let fetchCallCount = 0;

    relay.fetchBatchResult = [];
    const relayAsAny = relay as unknown as { fetchBatch(): Promise<TestRow[]> };
    const originalFetch = relayAsAny.fetchBatch.bind(relay);
    vi.spyOn(relayAsAny, 'fetchBatch').mockImplementation(async () => {
      fetchCallCount += 1;
      if (fetchCallCount === 1) {
        await new Promise<void>((resolve) => {
          resolveFirstFetch = resolve;
        });
      }
      return originalFetch();
    });

    const firstRun = relay.relay();
    // Three more callers arrive mid-pass. All three must share ONE extra pass, and each
    // promise must resolve only once that shared pass has actually run.
    const secondRun = relay.relay();
    const thirdRun = relay.relay();
    const fourthRun = relay.relay();
    resolveFirstFetch();
    await Promise.all([firstRun, secondRun, thirdRun, fourthRun]);

    expect(fetchCallCount).toBe(2); // in-flight pass + one coalesced extra, not four
  });

  it('a write made just before a racing relay() call is visible to the pass it resolves on', async () => {
    // The guarantee the old boolean-flag design lacked: a caller racing an in-flight pass
    // got a promise that could resolve before any fetch able to see their write had run, so
    // `insert(); await relay(); expect(...)` was a coin flip.
    const relay = new TestRelay(makeFakeDb());
    let resolveFirstFetch!: () => void;

    relay.fetchBatchResult = [];
    const relayAsAny = relay as unknown as { fetchBatch(): Promise<TestRow[]> };
    vi.spyOn(relayAsAny, 'fetchBatch').mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        resolveFirstFetch = resolve;
      });
      return []; // first pass sees nothing; the row below is written after it started
    });

    const firstRun = relay.relay();
    relay.fetchBatchResult = [
      { id: 'row-written-during-first-pass', attempts: 0, shouldFail: false },
    ];
    const secondRun = relay.relay();

    resolveFirstFetch();
    await Promise.all([firstRun, secondRun]);

    expect(relay.markSentCalls).toContain('row-written-during-first-pass');
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
