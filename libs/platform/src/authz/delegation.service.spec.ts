import { describe, expect, it, vi } from 'vitest';
import { DelegationService } from './delegation.service';

/**
 * Creating a delegation tells the person who received it.
 *
 * WHAT WAS WRONG. `request.delegation_created` had a template, a variable shape, a renderer and — once
 * the settings screen was made truthful — a toggle, and NO SENDER: nothing anywhere scheduled it. So a
 * delegation appeared in silence. The delegator knows, because they made the grant; the colleague who
 * now has to decide on their behalf, inside a window that expires, was the one nobody told. You cannot
 * use authority you do not know you have.
 *
 * THE NOTIFICATION IS INSIDE THE INSERT'S TRANSACTION, and the test asserts that rather than merely
 * asserting it was scheduled: the scheduler writes an outbox row the relay later picks up, so if the
 * two are not rolled back together a delegation can exist that nobody was told about — which is the
 * original bug, reachable again through a partial failure.
 */
function build(rowOverrides: Record<string, unknown> = {}) {
  const row = {
    id: 'delegation-1',
    fromUserId: 'user-delegator',
    toUserId: 'user-delegate',
    startsAt: new Date('2026-09-01T00:00:00.000Z'),
    endsAt: new Date('2026-09-14T00:00:00.000Z'),
    reason: 'annual leave',
    createdAt: new Date('2026-08-27T00:00:00.000Z'),
    ...rowOverrides,
  };
  const insertChain = {
    values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([row]) }),
  };
  // `resolveEmployeeNames` runs a select; returning a name row proves the sentence names a person.
  const selectChain = {
    from: vi.fn().mockReturnValue({
      // `displayName`, matching `resolveEmployeeNames`'s projection — `fullName` here made the
      // resolver return an empty name and the fallback fire, which looked like the fallback working.
      where: vi.fn().mockResolvedValue([{ id: 'user-delegator', displayName: 'Dana Delegator' }]),
    }),
  };
  const tx = {
    insert: vi.fn().mockReturnValue(insertChain),
    select: vi.fn().mockReturnValue(selectChain),
  };
  const db = {
    insert: vi.fn().mockReturnValue(insertChain),
    select: vi.fn().mockReturnValue(selectChain),
    transaction: vi.fn().mockImplementation((cb: (t: typeof tx) => unknown) => cb(tx)),
  };
  const notifScheduler = { schedule: vi.fn().mockResolvedValue(undefined) };
  const service = new DelegationService(db as never, notifScheduler as never);
  return { service, db, tx, notifScheduler, row };
}

const INPUT = {
  fromUserId: 'user-delegator',
  toUserId: 'user-delegate',
  startsAt: new Date('2026-09-01T00:00:00.000Z'),
  endsAt: new Date('2026-09-14T00:00:00.000Z'),
  reason: 'annual leave',
};

describe('DelegationService.create', () => {
  it('notifies the DELEGATE, not the delegator', async () => {
    // The delegator made the grant and needs no telling. Sending it to them instead would look
    // identical in every "a notification was scheduled" assertion.
    const { service, notifScheduler } = build();
    await service.create(INPUT);

    expect(notifScheduler.schedule).toHaveBeenCalledOnce();
    const [, input] = notifScheduler.schedule.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(input.type).toBe('request.delegation_created');
    expect(input.recipientId).toBe('user-delegate');
    expect(input.actorId).toBe('user-delegator');
  });

  it('names the delegator, because a uuid identifies nobody', async () => {
    const { service, notifScheduler } = build();
    await service.create(INPUT);

    const [, input] = notifScheduler.schedule.mock.calls[0] as [
      unknown,
      { vars: Record<string, unknown> },
    ];
    expect(input.vars.delegatorName).toBe('Dana Delegator');
    // And the window's end, which is what makes the authority temporary rather than a gift.
    expect(input.vars.endsAt).toBe('2026-09-14T00:00:00.000Z');
  });

  it('falls back to a nameless sentence rather than printing an id', async () => {
    /*
     * `nameOf` returns null on a miss precisely so `?? id` cannot creep in. An unresolvable delegator
     * degrades to "A colleague", which is a sentence; the id would be thirty-six hex characters in a
     * notification bell.
     */
    // Overridden on the TRANSACTION, not the pool: the resolver reads through `tx`, so stubbing
    // `db.select` here changed nothing and the name still resolved — the test passed for the wrong
    // reason until this was corrected.
    const { service, notifScheduler, tx } = build();
    tx.select.mockReturnValue({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
    });
    await service.create(INPUT);

    const [, input] = notifScheduler.schedule.mock.calls[0] as [
      unknown,
      { vars: Record<string, unknown> },
    ];
    expect(input.vars.delegatorName).toBe('A colleague');
    expect(input.vars.delegatorName).not.toContain('user-delegator');
  });

  it('schedules inside the insert transaction, so the two cannot disagree', async () => {
    const { service, db, tx, notifScheduler } = build();
    await service.create(INPUT);

    expect(db.transaction).toHaveBeenCalledOnce();
    // The executor handed to the scheduler is the TRANSACTION, not the pool.
    const [executor] = notifScheduler.schedule.mock.calls[0] as [unknown];
    expect(executor).toBe(tx);
  });

  it('keys idempotency on the delegation id, so a retry does not double-notify', async () => {
    const { service, notifScheduler } = build();
    await service.create(INPUT);
    const [, input] = notifScheduler.schedule.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(input.idempotencyKey).toBe('delegation_created:delegation-1');
  });

  it('refuses self-delegation before scheduling anything', async () => {
    // The guard must run first: a rejected delegation that still notified would tell somebody they
    // hold authority they were never granted.
    const { service, notifScheduler } = build();
    await expect(service.create({ ...INPUT, toUserId: INPUT.fromUserId })).rejects.toThrow(
      /yourself/i,
    );
    expect(notifScheduler.schedule).not.toHaveBeenCalled();
  });

  it('refuses an inverted window before scheduling anything', async () => {
    const { service, notifScheduler } = build();
    await expect(
      service.create({ ...INPUT, startsAt: INPUT.endsAt, endsAt: INPUT.startsAt }),
    ).rejects.toThrow(/before end/i);
    expect(notifScheduler.schedule).not.toHaveBeenCalled();
  });
});
