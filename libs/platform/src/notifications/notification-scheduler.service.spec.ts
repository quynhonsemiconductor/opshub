import { describe, expect, it, vi } from 'vitest';
import { NotificationSchedulerService } from './notification-scheduler.service';

/**
 * scheduled_at is stamped by the DATABASE (the Time rule, .github#29). The relay claims with the database's now(), so
 * the insert must not carry the host's clock. This guards against a host timestamp being added back.
 */
function makeTx() {
  const chain = {
    values: vi.fn().mockReturnThis(),
    onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
  };
  return { insert: vi.fn().mockReturnValue(chain), chain };
}

const pubSub = { wakeRelay: vi.fn().mockResolvedValue(undefined) };

describe('NotificationSchedulerService', () => {
  it('leaves scheduledAt to the database default', async () => {
    const tx = makeTx();
    await new NotificationSchedulerService(pubSub as never).schedule(
      tx as never,
      {
        recipientId: 'emp-1',
        type: 'overtime.submitted',
        vars: {},
      } as never,
    );

    const written = tx.chain.values.mock.calls[0][0] as { scheduledAt?: Date };
    expect(written.scheduledAt).toBeUndefined();
  });
});
