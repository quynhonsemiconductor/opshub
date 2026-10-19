import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { WebhookEnqueueService } from './webhook-enqueue.service';

/**
 * next_attempt_at is stamped by the DATABASE (the Time rule, .github#29). The fan-out must not write the host's clock:
 * the relay's due check compares it with the database's now().
 */
function makeTx() {
  const values = vi.fn().mockResolvedValue(undefined);
  const select = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([{ id: 'sub-1' }]),
  };
  return {
    select: vi.fn().mockReturnValue(select),
    insert: vi.fn().mockReturnValue({ values }),
    execute: vi.fn().mockResolvedValue(undefined),
    values,
  };
}

describe('WebhookEnqueueService.fanout', () => {
  it('leaves next_attempt_at to the database default, not the host clock', async () => {
    const tx = makeTx();
    await new WebhookEnqueueService().fanout(tx as never, 'request.approved', { id: 'r-1' });

    const rows = tx.values.mock.calls[0][0] as Array<{ nextAttemptAt?: Date }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].nextAttemptAt).toBeUndefined();
  });

  it('notifies the outbox inside the caller transaction, after the insert', async () => {
    const tx = makeTx();
    await new WebhookEnqueueService().fanout(tx as never, 'request.approved', { id: 'r-1' });

    expect(tx.execute).toHaveBeenCalledTimes(1);
    const { sql, params } = new PgDialect().sqlToQuery(tx.execute.mock.calls[0][0] as SQL);
    expect(sql).toBe('select pg_notify($1, $2)');
    expect(params).toEqual(['outbox', 'webhook']);
  });
});
