/**
 * The email and notification relays write their timestamps on the DATABASE's clock (the Time rule, .github#29). Each
 * assertion renders the SQL the relay hands to the update, so a host Date put back in would fail here.
 */
import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { EmailRelayService } from './email-relay.service';
import { NotificationRelayService } from './notification-relay.service';

const dialect = new PgDialect();

function updateChain() {
  const set = vi.fn().mockReturnThis();
  const tx = { update: vi.fn().mockReturnThis(), set, where: vi.fn().mockResolvedValue(undefined) };
  return { tx, set };
}

const row = { id: 'r1', attempts: 1 } as never;

type Internals = {
  markSent(tx: unknown, row: unknown, messageId?: string | null): Promise<void>;
  markFailed(
    tx: unknown,
    row: unknown,
    status: 'pending' | 'failed',
    error: string,
    delayMs: number,
  ): Promise<void>;
};

describe('email relay writes on the database clock', () => {
  const service = new EmailRelayService(
    {} as never,
    { assertReady: vi.fn() } as never,
  ) as unknown as Internals;

  it('markSent stamps sentAt as now(), not a host Date', async () => {
    const { tx, set } = updateChain();
    await service.markSent(tx, row, 'msg-1');
    expect(
      dialect.sqlToQuery((set.mock.calls[0][0] as Record<string, SQL>)['sentAt']),
    ).toMatchObject({
      sql: 'now()',
      params: [],
    });
  });

  it('markFailed schedules the retry as now() + the delay, bound as seconds', async () => {
    const { tx, set } = updateChain();
    await service.markFailed(tx, row, 'pending', 'smtp down', 30_000);
    expect(
      dialect.sqlToQuery((set.mock.calls[0][0] as Record<string, SQL>)['scheduledAt']),
    ).toMatchObject({
      sql: 'now() + make_interval(secs => $1)',
      params: [30],
    });
  });
});

describe('notification relay writes on the database clock', () => {
  const service = new NotificationRelayService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  ) as unknown as Internals;

  it('markSent stamps dispatchedAt as now(), not a host Date', async () => {
    const { tx, set } = updateChain();
    await service.markSent(tx, row);
    expect(
      dialect.sqlToQuery((set.mock.calls[0][0] as Record<string, SQL>)['dispatchedAt']),
    ).toMatchObject({
      sql: 'now()',
      params: [],
    });
  });

  it('markFailed schedules the retry as now() + the delay, bound as seconds', async () => {
    const { tx, set } = updateChain();
    await service.markFailed(tx, row, 'pending', 'db down', 60_000);
    expect(
      dialect.sqlToQuery((set.mock.calls[0][0] as Record<string, SQL>)['scheduledAt']),
    ).toMatchObject({
      sql: 'now() + make_interval(secs => $1)',
      params: [60],
    });
  });
});
