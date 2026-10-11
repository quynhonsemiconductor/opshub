/**
 * The worker's executor for Graph tasks: what each kind calls, what an unknown kind does, ordering and
 * leases, that scans take the cron's lock, and that a worker with Graph off claims nothing — so a queued
 * offboarding waits for the app rather than being dropped.
 */
import { describe, expect, it, vi } from 'vitest';
import { NonRetryableError, RetryAfterError } from '@platform';
import { GRAPH_TASK } from '../graph-task';
import { GRAPH_LOCK } from '../graph-locks';
import { GraphTaskRelayService } from './graph-task-relay.service';

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
  const relay = new GraphTaskRelayService(
    {} as never,
    graph as never,
    accounts as never,
    scan as never,
    posture as never,
    exclusive as never,
  );
  return { relay: relay as unknown as Internals, accounts, scan, posture, exclusive, locks };
}

const row = (kind: string, payload: Record<string, unknown> = {}): Row => ({
  id: 'r1',
  kind,
  payload,
  attempts: 1,
  createdAt: new Date(),
  leaseToken: 't',
});

describe('GraphTaskRelayService.deliver', () => {
  it('reconciles an account by EMPLOYEE id — it is never given a directory object id', async () => {
    const { relay, accounts } = make();
    await relay.deliver(row(GRAPH_TASK.ACCOUNT_RECONCILE, { employeeId: 'emp-1' }));
    expect(accounts.reconcile).toHaveBeenCalledWith('emp-1');
  });

  it('runs a shadow-IT scan under the SAME lock the cron takes', async () => {
    const { relay, scan, locks } = make();
    await relay.deliver(row(GRAPH_TASK.SHADOW_IT_SCAN));
    expect(scan.detectShadowIt).toHaveBeenCalledTimes(1);
    expect(locks).toEqual([GRAPH_LOCK.SHADOW_IT.name]);
  });

  it('runs a posture sync under the same lock as the cron', async () => {
    const { relay, posture, locks } = make();
    await relay.deliver(row(GRAPH_TASK.POSTURE_SYNC));
    expect(posture.runPostureSync).toHaveBeenCalledTimes(1);
    expect(locks).toEqual([GRAPH_LOCK.POSTURE.name]);
  });

  it("does not run a second scan while the cron's is running: that run covers this request", async () => {
    const { relay, scan } = make({ lockHeld: true });
    await relay.deliver(row(GRAPH_TASK.SHADOW_IT_SCAN));
    expect(scan.detectShadowIt).not.toHaveBeenCalled();
  });

  it('dead-letters a payload with no employeeId, and an unknown kind, without retrying', async () => {
    const { relay } = make();
    await expect(relay.deliver(row(GRAPH_TASK.ACCOUNT_RECONCILE, {}))).rejects.toBeInstanceOf(
      NonRetryableError,
    );
    await expect(relay.deliver(row('entra.something.new'))).rejects.toBeInstanceOf(
      NonRetryableError,
    );
  });

  it('classifies Graph failures: 403 is not retried, 429 + Retry-After is waited out', async () => {
    const { relay, accounts } = make();
    accounts.reconcile.mockRejectedValueOnce(
      Object.assign(new Error('forbidden'), { statusCode: 403 }),
    );
    await expect(
      relay.deliver(row(GRAPH_TASK.ACCOUNT_RECONCILE, { employeeId: 'e' })),
    ).rejects.toBeInstanceOf(NonRetryableError);

    accounts.reconcile.mockRejectedValueOnce(
      Object.assign(new Error('slow down'), { statusCode: 429, headers: { get: () => '90' } }),
    );
    await expect(
      relay.deliver(row(GRAPH_TASK.ACCOUNT_RECONCILE, { employeeId: 'e' })),
    ).rejects.toBeInstanceOf(RetryAfterError);
  });
});

describe('GraphTaskRelayService leases and claiming', () => {
  it('gives scans and syncs a long lease and account tasks a short one', () => {
    const { relay } = make();
    expect(relay.leaseMsFor({ kind: GRAPH_TASK.SHADOW_IT_SCAN })).toBeGreaterThanOrEqual(
      30 * 60_000,
    );
    expect(relay.leaseMsFor({ kind: GRAPH_TASK.POSTURE_SYNC })).toBeGreaterThanOrEqual(30 * 60_000);
    expect(relay.leaseMsFor({ kind: GRAPH_TASK.ACCOUNT_RECONCILE })).toBeLessThanOrEqual(
      5 * 60_000,
    );
  });

  it('with Graph off, claims nothing: the transaction is never queried and the rows stay pending', async () => {
    const { relay } = make({ enabled: false });
    const tx = { select: vi.fn() };
    expect(await relay.selectDue(tx, 10, new Date())).toEqual([]);
    expect(tx.select).not.toHaveBeenCalled();
  });

  it('ends a batch at the first long task, so the rows behind it do not wait out its whole run', async () => {
    const { relay } = make();
    const rows = [
      { id: '1', kind: GRAPH_TASK.ACCOUNT_RECONCILE },
      { id: '2', kind: GRAPH_TASK.SHADOW_IT_SCAN },
      { id: '3', kind: GRAPH_TASK.ACCOUNT_RECONCILE },
    ];
    const chain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      for: vi.fn().mockResolvedValue(rows),
    };
    const tx = { select: vi.fn().mockReturnValue(chain) };

    const batch = (await relay.selectDue(tx, 10, new Date())) as Array<{ id: string }>;

    expect(batch.map((r) => r.id)).toEqual(['1', '2']);
  });
});
