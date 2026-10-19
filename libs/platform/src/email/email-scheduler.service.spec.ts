import { describe, expect, it, vi } from 'vitest';
import { EmailSchedulerService } from './email-scheduler.service';

/**
 * scheduled_at is stamped by the DATABASE (the Time rule, .github#29). The application must not write the host's clock
 * into the insert: a database that runs ahead of the host would then stamp rows the relay considers "in the future".
 */
function makeTx() {
  const chain = {
    values: vi.fn().mockReturnThis(),
    onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
  };
  return { insert: vi.fn().mockReturnValue(chain), chain };
}

const pubSub = { wakeEmailRelay: vi.fn().mockResolvedValue(undefined) };

describe('EmailSchedulerService', () => {
  it('leaves scheduledAt to the database default when the caller has no time to keep', async () => {
    const tx = makeTx();
    await new EmailSchedulerService(pubSub as never).schedule(
      tx as never,
      'a@qnsc.vn',
      'ping' as never,
      {} as never,
    );

    const written = tx.chain.values.mock.calls[0][0] as { scheduledAt?: Date };
    expect(written.scheduledAt).toBeUndefined();
  });

  it('keeps a time the caller supplies', async () => {
    const tx = makeTx();
    const at = new Date('2026-01-02T03:04:05Z');
    await new EmailSchedulerService(pubSub as never).schedule(
      tx as never,
      'a@qnsc.vn',
      'ping' as never,
      {} as never,
      {
        scheduledAt: at,
      },
    );

    const written = tx.chain.values.mock.calls[0][0] as { scheduledAt?: Date };
    expect(written.scheduledAt).toBe(at);
  });
});
