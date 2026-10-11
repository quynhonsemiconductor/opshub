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
  return { insert: vi.fn().mockReturnValue(chain), chain };
}

describe('GraphTaskQueue', () => {
  it("writes through the caller's transaction when given one, not the root database", async () => {
    const root = makeDb([{ id: 'x' }]);
    const tx = makeDb([{ id: 'y' }]);

    await new GraphTaskQueue(root as never).enqueue(
      { kind: GRAPH_TASK.SESSIONS_REVOKE, payload: { entraOid: 'o1' } },
      tx as never,
    );

    expect(tx.insert).toHaveBeenCalledWith(graphTaskOutbox);
    expect(root.insert).not.toHaveBeenCalled();
    expect(tx.chain.values).toHaveBeenCalledWith({
      kind: 'entra.sessions.revoke',
      payload: { entraOid: 'o1' },
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
      dedupeKeyFor({
        kind: GRAPH_TASK.ACCOUNT_SET_ENABLED,
        payload: { entraOid: 'o', enabled: false },
      }),
    ).toBeNull();
    expect(
      dedupeKeyFor({ kind: GRAPH_TASK.SESSIONS_REVOKE, payload: { entraOid: 'o' } }),
    ).toBeNull();
  });
});
