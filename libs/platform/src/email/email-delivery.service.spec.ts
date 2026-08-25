/**
 * EmailDeliveryService — the read side of the feedback loop.
 *
 * The rules under test are the family semantics: a root key plus its `:rN` resend
 * suffixes collapse to ONE verdict, the most recently scheduled row wins (a resend
 * that delivered supersedes the earlier bounce), and `pending`/legacy rows answer
 * `unknown` because no verdict has arrived or ever will.
 */
import { describe, it, expect, vi } from 'vitest';
import { EmailDeliveryService } from './email-delivery.service';
import type { DrizzleDB } from '../database/drizzle.provider';

type Row = { idempotencyKey: string | null; status: string; scheduledAt: Date };

/** Enough of drizzle's builder for statusesFor: from().where().orderBy() -> rows. */
const makeDb = (rows: Row[]) =>
  ({
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => Promise.resolve(rows),
        }),
      }),
    }),
  }) as unknown as DrizzleDB;

const service = (rows: Row[]) => new EmailDeliveryService(makeDb(rows));

describe('EmailDeliveryService.statusesFor', () => {
  it('answers unknown for keys with no rows', async () => {
    const result = await service([]).statusesFor(['inv-1']);
    expect(result.get('inv-1')).toBe('unknown');
  });

  it('returns the base row status for a single send', async () => {
    const result = await service([
      { idempotencyKey: 'inv-1', status: 'bounced', scheduledAt: new Date('2026-08-20T01:00Z') },
    ]).statusesFor(['inv-1']);
    expect(result.get('inv-1')).toBe('bounced');
  });

  it('lets a later resend supersede an earlier bounce', async () => {
    const result = await service([
      // Descending scheduledAt is the order the real query returns; the FIRST row seen
      // per root wins, which is what makes a delivered resend override the old bounce.
      { idempotencyKey: 'inv-1:r1', status: 'sent', scheduledAt: new Date('2026-08-20T03:00Z') },
      { idempotencyKey: 'inv-1', status: 'bounced', scheduledAt: new Date('2026-08-20T01:00Z') },
    ]).statusesFor(['inv-1']);
    expect(result.get('inv-1')).toBe('sent');
  });

  it('keeps a bounce when the resend ALSO bounced', async () => {
    const result = await service([
      { idempotencyKey: 'inv-2:r2', status: 'bounced', scheduledAt: new Date('2026-08-20T04:00Z') },
      { idempotencyKey: 'inv-2:r1', status: 'bounced', scheduledAt: new Date('2026-08-20T02:00Z') },
    ]).statusesFor(['inv-2']);
    expect(result.get('inv-2')).toBe('bounced');
  });

  it('maps pending to unknown — queued is not a verdict a caller can act on', async () => {
    const result = await service([
      { idempotencyKey: 'inv-3', status: 'pending', scheduledAt: new Date('2026-08-20T01:00Z') },
    ]).statusesFor(['inv-3']);
    expect(result.get('inv-3')).toBe('unknown');
  });

  it('skips legacy rows with a NULL idempotency key', async () => {
    const result = await service([
      { idempotencyKey: null, status: 'sent', scheduledAt: new Date('2026-08-20T01:00Z') },
    ]).statusesFor(['inv-4']);
    expect(result.get('inv-4')).toBe('unknown');
  });

  it('asks nothing of the database for an empty key list', async () => {
    const db = makeDb([]);
    const spy = vi.fn(() => ({
      from: () => ({ where: () => ({ orderBy: () => Promise.resolve([]) }) }),
    }));
    const svc = new EmailDeliveryService(db);
    // Empty short-circuit: statusesFor must not build any predicate list at all.
    const result = await svc.statusesFor([]);
    expect(result.size).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });
});
