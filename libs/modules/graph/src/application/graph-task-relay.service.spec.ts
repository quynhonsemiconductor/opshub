/**
 * The worker's executors for Graph tasks: what each kind calls, what an unknown kind does, that scans
 * take the cron's lock and WAIT (not "finish") when it is held, that the two relays claim disjoint kinds
 * with leases derived from their call budgets, and that a worker with Graph off claims nothing — so a
 * queued offboarding waits for the app rather than being dropped.
 */
import { describe, expect, it, vi } from 'vitest';
import { DeferError, NonRetryableError, RetryAfterError } from '@platform';
import { GRAPH_TASK, graphLeaseMs } from '../graph-task';
import { GRAPH_LOCK } from '../graph-locks';
import { GraphAccountRelayService, GraphScanRelayService } from './graph-task-relay.service';

interface Row {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  createdAt: Date;
  leaseToken: string;
}
interface Internals {
  deliver(row: Row): Promise<void>;
  selectDue(tx: unknown, limit: number, now: Date): Promise<unknown[]>;
  leaseMsFor(row: { kind: string }): number;
  kinds: readonly string[];
  batchSize: number;
}

function make({ enabled = true, lockHeld = false } = {}) {
  const accounts = { reconcile: vi.fn().mockResolvedValue(undefined) };
  const scan = { detectShadowIt: vi.fn().mockResolvedValue({ scanned: 0, newFindings: 0 }) };
  const posture = { runPostureSync: vi.fn().mockResolvedValue({ controls: 0 }) };
  const graph = { isEnabled: vi.fn().mockReturnValue(enabled) };
  const locks: string[] = [];
  const exclusive = {
    run: vi.fn(async (name: string, _ttl: number, fn: () => Promise<void>) => {
      locks.push(name);
      if (!lockHeld) await fn();
    }),
  };
  const args = [
    {} as never,
    graph as never,
    accounts as never,
    scan as never,
    posture as never,
    exclusive as never,
  ] as const;
  return {
    account: new GraphAccountRelayService(...args) as unknown as Internals,
    scanRelay: new GraphScanRelayService(...args) as unknown as Internals,
    accounts,
    scan,
    posture,
    locks,
  };
}

const row = (kind: string, payload: Record<string, unknown> = {}): Row => ({
  id: 'r1',
  kind,
  payload,
  attempts: 1,
  createdAt: new Date(),
  leaseToken: 't',
});

describe('Graph task relays — deliver', () => {
  it('reconciles an account by EMPLOYEE id — it is never given a directory object id', async () => {
    const { account, accounts } = make();
    await account.deliver(row(GRAPH_TASK.ACCOUNT_RECONCILE, { employeeId: 'emp-1' }));
    expect(accounts.reconcile).toHaveBeenCalledWith('emp-1');
  });

  it('runs a shadow-IT scan under the SAME lock the cron takes', async () => {
    const { scanRelay, scan, locks } = make();
    await scanRelay.deliver(row(GRAPH_TASK.SHADOW_IT_SCAN));
    expect(scan.detectShadowIt).toHaveBeenCalledTimes(1);
    expect(locks).toEqual([GRAPH_LOCK.SHADOW_IT.name]);
  });

  it('runs a posture sync under the same lock as the cron', async () => {
    const { scanRelay, posture, locks } = make();
    await scanRelay.deliver(row(GRAPH_TASK.POSTURE_SYNC));
    expect(posture.runPostureSync).toHaveBeenCalledTimes(1);
    expect(locks).toEqual([GRAPH_LOCK.POSTURE.name]);
  });

  it.each([GRAPH_TASK.SHADOW_IT_SCAN, GRAPH_TASK.POSTURE_SYNC])(
    "%s: when the cron's lock is HELD the request is DEFERRED (pending, attempt refunded) — never marked done",
    async (kind) => {
      /*
       * The holder may be a crashed run whose lock lives for hours, and may have started before the data
       * this request is about. Marking the row sent would report a scan that never happened.
       */
      const { scanRelay, scan, posture } = make({ lockHeld: true });

      await expect(scanRelay.deliver(row(kind))).rejects.toBeInstanceOf(DeferError);

      expect(scan.detectShadowIt).not.toHaveBeenCalled();
      expect(posture.runPostureSync).not.toHaveBeenCalled();
    },
  );

  it('dead-letters a payload with no employeeId, and an unknown kind, without retrying', async () => {
    const { account } = make();
    await expect(account.deliver(row(GRAPH_TASK.ACCOUNT_RECONCILE, {}))).rejects.toBeInstanceOf(
      NonRetryableError,
    );
    await expect(account.deliver(row('entra.something.new'))).rejects.toBeInstanceOf(
      NonRetryableError,
    );
  });

  it('classifies Graph failures: 403 is not retried, 429 + Retry-After is waited out', async () => {
    const { account, accounts } = make();
    accounts.reconcile.mockRejectedValueOnce(
      Object.assign(new Error('forbidden'), { statusCode: 403 }),
    );
    await expect(
      account.deliver(row(GRAPH_TASK.ACCOUNT_RECONCILE, { employeeId: 'e' })),
    ).rejects.toBeInstanceOf(NonRetryableError);

    accounts.reconcile.mockRejectedValueOnce(
      Object.assign(new Error('slow down'), { statusCode: 429, headers: { get: () => '90' } }),
    );
    await expect(
      account.deliver(row(GRAPH_TASK.ACCOUNT_RECONCILE, { employeeId: 'e' })),
    ).rejects.toBeInstanceOf(RetryAfterError);
  });
});

describe('Graph task relays — separation, leases and claiming', () => {
  it('claim DISJOINT kinds, so an account task is never batched with, or behind, a scan', () => {
    const { account, scanRelay } = make();

    expect(account.kinds).toEqual([GRAPH_TASK.ACCOUNT_RECONCILE]);
    expect(scanRelay.kinds).toEqual([GRAPH_TASK.SHADOW_IT_SCAN, GRAPH_TASK.POSTURE_SYNC]);
    expect(account.kinds.filter((k) => scanRelay.kinds.includes(k))).toEqual([]);
    // Every kind is claimed by exactly one relay.
    expect([...account.kinds, ...scanRelay.kinds].sort()).toEqual(Object.values(GRAPH_TASK).sort());
  });

  it('claims scans ONE at a time and account tasks in batches', () => {
    const { account, scanRelay } = make();
    expect(scanRelay.batchSize).toBe(1);
    expect(account.batchSize).toBeGreaterThan(1);
  });

  it("uses the lease derived from each kind's call budget", () => {
    const { account, scanRelay } = make();
    for (const kind of Object.values(GRAPH_TASK)) {
      const relay = account.kinds.includes(kind) ? account : scanRelay;
      expect(relay.leaseMsFor({ kind })).toBe(graphLeaseMs(kind));
    }
  });

  it('gives an account task a short lease and a scan a long one', () => {
    const { account, scanRelay } = make();
    expect(account.leaseMsFor({ kind: GRAPH_TASK.ACCOUNT_RECONCILE })).toBeLessThanOrEqual(
      5 * 60_000,
    );
    expect(scanRelay.leaseMsFor({ kind: GRAPH_TASK.SHADOW_IT_SCAN })).toBeGreaterThanOrEqual(
      30 * 60_000,
    );
  });

  it.each(['account', 'scanRelay'] as const)(
    '%s relay, with Graph off, claims nothing: the transaction is never queried and rows stay pending',
    async (which) => {
      const relays = make({ enabled: false });
      const tx = { select: vi.fn() };
      expect(await relays[which].selectDue(tx, 10, new Date())).toEqual([]);
      expect(tx.select).not.toHaveBeenCalled();
    },
  );
});
