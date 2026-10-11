import { describe, expect, it, vi } from 'vitest';
import { GRAPH_HEARTBEAT_PREFIX } from '../graph-task';
import { GraphSyncCron } from './graph-sync.cron';

function make(enabled: boolean) {
  const values = vi
    .fn()
    .mockReturnValue({ onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) });
  const where = vi.fn().mockResolvedValue(undefined);
  const db = {
    insert: vi.fn().mockReturnValue({ values }),
    delete: vi.fn().mockReturnValue({ where }),
  };
  const cron = new GraphSyncCron(
    { isEnabled: () => enabled } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    db as never,
  );
  return { cron, values, db, where };
}

describe('GraphSyncCron.heartbeat', () => {
  it.each([
    [true, 'enabled'],
    [false, 'disabled'],
  ])("with Graph %s it writes `%s`, under THIS replica's own key", async (enabled, expected) => {
    process.env['HOSTNAME'] = 'worker-7d9f';
    const { cron, values } = make(enabled);

    await cron.heartbeat();

    expect(values).toHaveBeenCalledWith({
      name: `${GRAPH_HEARTBEAT_PREFIX}worker-7d9f`,
      cursor: expected,
    });
  });

  it("two replicas write two rows, so one cannot overwrite the other's answer", async () => {
    const names: string[] = [];
    for (const pod of ['worker-a', 'worker-b']) {
      process.env['HOSTNAME'] = pod;
      const { cron, values } = make(true);
      await cron.heartbeat();
      names.push((values.mock.calls[0][0] as { name: string }).name);
    }
    expect(new Set(names).size).toBe(2);
  });

  it('removes the rows of replicas that have been gone a day', async () => {
    const { cron, db } = make(true);
    await cron.heartbeat();
    expect(db.delete).toHaveBeenCalledTimes(1);
  });

  it('never throws: a database blip must not crash the cron', async () => {
    const { cron } = make(true);
    (cron as unknown as { db: { insert: () => never } }).db.insert = () => {
      throw new Error('db down');
    };
    await expect(cron.heartbeat()).resolves.toBeUndefined();
  });
});
