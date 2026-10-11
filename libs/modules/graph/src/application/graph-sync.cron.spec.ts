import { describe, expect, it, vi } from 'vitest';
import { GRAPH_HEARTBEAT_STATE } from '../graph-task';
import { GraphSyncCron } from './graph-sync.cron';

function make(enabled: boolean) {
  const values = vi
    .fn()
    .mockReturnValue({ onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) });
  const db = { insert: vi.fn().mockReturnValue({ values }) };
  const cron = new GraphSyncCron(
    { isEnabled: () => enabled } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    db as never,
  );
  return { cron, values };
}

describe('GraphSyncCron.heartbeat', () => {
  it.each([
    [true, 'enabled'],
    [false, 'disabled'],
  ])('with Graph %s it writes `%s`', async (enabled, expected) => {
    const { cron, values } = make(enabled);

    await cron.heartbeat();

    expect(values).toHaveBeenCalledWith({ name: GRAPH_HEARTBEAT_STATE, cursor: expected });
  });

  it('never throws: a database blip must not crash the cron', async () => {
    const { cron } = make(true);
    (cron as unknown as { db: { insert: () => never } }).db.insert = () => {
      throw new Error('db down');
    };
    await expect(cron.heartbeat()).resolves.toBeUndefined();
  });
});
