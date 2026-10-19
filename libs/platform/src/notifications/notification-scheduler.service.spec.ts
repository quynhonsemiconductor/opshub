import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
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
  return {
    insert: vi.fn().mockReturnValue(chain),
    execute: vi.fn().mockResolvedValue(undefined),
    chain,
  };
}

describe('NotificationSchedulerService', () => {
  it('leaves scheduledAt to the database default', async () => {
    const tx = makeTx();
    await new NotificationSchedulerService().schedule(
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

  it('notifies the outbox inside the caller transaction, after the insert', async () => {
    const tx = makeTx();
    await new NotificationSchedulerService().schedule(
      tx as never,
      { recipientId: 'emp-1', type: 'overtime.submitted', vars: {} } as never,
    );

    expect(tx.execute).toHaveBeenCalledTimes(1);
    const { sql, params } = new PgDialect().sqlToQuery(tx.execute.mock.calls[0][0] as SQL);
    expect(sql).toBe('select pg_notify($1, $2)');
    expect(params).toEqual(['outbox', 'notification']);
  });
});
