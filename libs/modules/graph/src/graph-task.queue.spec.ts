import { describe, expect, it, vi } from 'vitest';
import { graphTaskOutbox } from '../../../../db/schema';
import { dedupeKeyFor, GRAPH_TASK } from './graph-task';
import { GraphTaskQueue } from './graph-task.queue';

function makeDb(returning: unknown[]) {
  const chain = {
    values: vi.fn().mockReturnThis(),
    onConflictDoNothing: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue(returning),
  };
  return {
    insert: vi.fn().mockReturnValue(chain),
    execute: vi.fn().mockResolvedValue(undefined),
    chain,
  };
}

describe('GraphTaskQueue', () => {
  it("writes through the caller's transaction when given one, not the root database", async () => {
    const root = makeDb([{ id: 'x' }]);
    const tx = makeDb([{ id: 'y' }]);

    await new GraphTaskQueue(root as never).enqueue(
      { kind: GRAPH_TASK.ACCOUNT_RECONCILE, payload: { employeeId: 'emp-1' } },
      tx as never,
    );

    expect(tx.insert).toHaveBeenCalledWith(graphTaskOutbox);
    expect(root.insert).not.toHaveBeenCalled();
    // The wake is in the same transaction, so it is delivered at its commit.
    expect(tx.execute).toHaveBeenCalledTimes(1);
    expect(root.execute).not.toHaveBeenCalled();
    // Keyed by employee, so two tasks for one person never overlap; never merged.
    expect(tx.chain.values).toHaveBeenCalledWith({
      kind: 'entra.account.reconcile',
      payload: { employeeId: 'emp-1' },
      orderingKey: 'emp-1',
      dedupeKey: null,
    });
  });

  it('reports whether a new row was written (false when an equal pending task absorbed it)', async () => {
    const queue = new GraphTaskQueue(makeDb([]) as never);
    expect(await queue.enqueue({ kind: GRAPH_TASK.SHADOW_IT_SCAN, payload: {} })).toBe(false);
    expect(
      await new GraphTaskQueue(makeDb([{ id: 'x' }]) as never).enqueue({
        kind: GRAPH_TASK.SHADOW_IT_SCAN,
        payload: {},
      }),
    ).toBe(true);
  });

  it('merges scans and syncs, never account tasks (a disable then an enable are both meant)', () => {
    expect(dedupeKeyFor({ kind: GRAPH_TASK.SHADOW_IT_SCAN, payload: {} })).toBe(
      'compliance.shadow_it.scan',
    );
    expect(dedupeKeyFor({ kind: GRAPH_TASK.POSTURE_SYNC, payload: {} })).toBe(
      'security.posture.sync',
    );
    expect(
      dedupeKeyFor({ kind: GRAPH_TASK.ACCOUNT_RECONCILE, payload: { employeeId: 'e' } }),
    ).toBeNull();
  });
});

describe('GraphTaskQueue availability (the per-replica worker heartbeat)', () => {
  const NOW = new Date('2026-10-11T12:00:00Z');
  const row = (cursor: string | null, agoMs: number) => ({
    cursor,
    updatedAt: new Date(NOW.getTime() - agoMs),
  });

  function queueWith(rows: Array<{ cursor: string | null; updatedAt: Date }>) {
    const select = { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue(rows) };
    return new GraphTaskQueue({ select: vi.fn().mockReturnValue(select) } as never);
  }

  it('is available when a replica said `enabled` a moment ago', async () => {
    expect(await queueWith([row('enabled', 20_000)]).isGraphAvailable(NOW)).toBe(true);
  });

  it('is available when ANY replica is enabled and fresh — a disabled or crashed one cannot hide it', async () => {
    const q = queueWith([
      row('disabled', 1_000),
      row('enabled', 10 * 60_000),
      row('enabled', 5_000),
    ]);
    expect(await q.isGraphAvailable(NOW)).toBe(true);
  });

  it.each([
    ['every replica said `disabled`', [row('disabled', 1_000), row('disabled', 2_000)]],
    ['the only `enabled` heartbeat is stale (that replica is down)', [row('enabled', 10 * 60_000)]],
    ['there is no heartbeat at all', []],
  ])('is NOT available when %s', async (_name, rows) => {
    expect(await queueWith(rows).isGraphAvailable(NOW)).toBe(false);
  });

  it('requireGraphAvailable throws 409 GRAPH_DISABLED, so the UI does not promise a scan that never runs', async () => {
    await expect(queueWith([]).requireGraphAvailable()).rejects.toMatchObject({
      code: 'GRAPH_DISABLED',
      httpStatus: 409,
    });
  });
});
