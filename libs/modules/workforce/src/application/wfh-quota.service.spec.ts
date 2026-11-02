/**
 * WfhQuotaService — the weekly allowance rules.
 *
 * The database is a stub that answers the two reads the service makes, in the order it makes them: first the
 * allowance of the employee's rank, then the pending and approved requests that overlap the weeks asked
 * about. The status filter and the join are SQL, so a stub cannot prove them; what IS under test is the
 * arithmetic the service does on the rows — that weeks are counted separately and never carry over, that a
 * zero allowance blocks filing, and that a request is judged week by week.
 */
import { describe, expect, it, vi } from 'vitest';
import { PreconditionFailedException } from '@platform';
import { WfhQuotaService } from './wfh-quota.service';

// 2026-11-02 is a Monday: 2026-11-02 … 2026-11-08 is one week and 2026-11-09 … 2026-11-15 the next.
const _EMPLOYEE_ID = 'emp-1';
const _MONDAY_WEEK_ONE = '2026-11-02';
const _TUESDAY_WEEK_ONE = '2026-11-03';
const _WEDNESDAY_WEEK_ONE = '2026-11-04';
const _MONDAY_WEEK_TWO = '2026-11-09';
const _TUESDAY_WEEK_TWO = '2026-11-10';

/** A chainable stand-in for a Drizzle select: every builder step returns itself, and it resolves to `rows`. */
function selectResolvingTo(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const step of ['from', 'innerJoin', 'where']) chain[step] = () => chain;
  chain.limit = () => Promise.resolve(rows);
  chain.then = (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  return chain;
}

/**
 * Builds the service over a stub database.
 *
 * Args:
 *   weeklyAllowance: What the rank's `wfh_weekly_days` benefit says; null means no ranked position.
 *   claimingRequests: The pending and approved requests the second read returns.
 */
function makeService(
  weeklyAllowance: number | null,
  claimingRequests: { startDate: string; endDate: string }[] = [],
) {
  const allowanceRows = weeklyAllowance === null ? [] : [{ allowance: weeklyAllowance }];
  const select = vi
    .fn()
    .mockReturnValueOnce(selectResolvingTo(allowanceRows))
    .mockReturnValueOnce(selectResolvingTo(claimingRequests));
  const balances = { holidaysBetween: vi.fn().mockResolvedValue(new Set<string>()) };
  return new WfhQuotaService({ select } as never, balances as never);
}

describe('assertWithinQuota', () => {
  it('refuses when the employee holds no ranked position, so there is no allowance', async () => {
    const service = makeService(null);

    await expect(service.assertWithinQuota(_EMPLOYEE_ID, [_MONDAY_WEEK_ONE])).rejects.toMatchObject(
      { code: 'WFH_QUOTA_NONE' },
    );
  });

  it('refuses when the rank allows zero days', async () => {
    const service = makeService(0);

    await expect(
      service.assertWithinQuota(_EMPLOYEE_ID, [_MONDAY_WEEK_ONE]),
    ).rejects.toBeInstanceOf(PreconditionFailedException);
  });

  it('allows a request that fits the week', async () => {
    const service = makeService(2);

    await expect(
      service.assertWithinQuota(_EMPLOYEE_ID, [_MONDAY_WEEK_ONE, _TUESDAY_WEEK_ONE]),
    ).resolves.toBeUndefined();
  });

  it('refuses a request asking for more days than the week allows', async () => {
    const service = makeService(2);

    await expect(
      service.assertWithinQuota(_EMPLOYEE_ID, [
        _MONDAY_WEEK_ONE,
        _TUESDAY_WEEK_ONE,
        _WEDNESDAY_WEEK_ONE,
      ]),
    ).rejects.toMatchObject({ code: 'WFH_QUOTA_EXCEEDED' });
  });

  it('counts days a pending or approved request already claims in the same week', async () => {
    // Two of the two allowed days are already claimed, so one more day has nowhere to go.
    const service = makeService(2, [{ startDate: _MONDAY_WEEK_ONE, endDate: _TUESDAY_WEEK_ONE }]);

    await expect(
      service.assertWithinQuota(_EMPLOYEE_ID, [_WEDNESDAY_WEEK_ONE]),
    ).rejects.toMatchObject({ code: 'WFH_QUOTA_EXCEEDED' });
  });

  it('judges each week on its own, so unused days never carry into the next week', async () => {
    // The allowance is 2 a week. Two days in each of two weeks is within quota even though it is four
    // days in total — and nothing claimed last week reduces this week.
    const service = makeService(2, [{ startDate: _MONDAY_WEEK_ONE, endDate: _TUESDAY_WEEK_ONE }]);

    await expect(
      service.assertWithinQuota(_EMPLOYEE_ID, [_MONDAY_WEEK_TWO, _TUESDAY_WEEK_TWO]),
    ).resolves.toBeUndefined();
  });

  it('names the week and the days left when a request goes over', async () => {
    const service = makeService(2, [{ startDate: _MONDAY_WEEK_ONE, endDate: _MONDAY_WEEK_ONE }]);

    await expect(
      service.assertWithinQuota(_EMPLOYEE_ID, [_TUESDAY_WEEK_ONE, _WEDNESDAY_WEEK_ONE]),
    ).rejects.toThrow(/Week of 2026-11-02: 2 day\(s\) requested but 1 left of 2/);
  });
});

describe('getWeekQuota', () => {
  it('reports the allowance, the days used and what remains for the week containing the date', async () => {
    const service = makeService(3, [{ startDate: _MONDAY_WEEK_ONE, endDate: _TUESDAY_WEEK_ONE }]);

    const quota = await service.getWeekQuota(_EMPLOYEE_ID, _WEDNESDAY_WEEK_ONE);

    expect(quota).toEqual({
      weekStart: _MONDAY_WEEK_ONE,
      weekEnd: '2026-11-08',
      weeklyAllowance: 3,
      usedDays: 2,
      remainingDays: 1,
    });
  });

  it('never reports a negative remainder when the allowance was lowered below what is claimed', async () => {
    const service = makeService(1, [{ startDate: _MONDAY_WEEK_ONE, endDate: _TUESDAY_WEEK_ONE }]);

    const quota = await service.getWeekQuota(_EMPLOYEE_ID, _MONDAY_WEEK_ONE);

    expect(quota.remainingDays).toBe(0);
  });

  it('counts only the working days a claiming request has inside the asked-about week', async () => {
    // A request running Friday of week one to Tuesday of week two claims one day in week one.
    const service = makeService(5, [{ startDate: '2026-11-06', endDate: _TUESDAY_WEEK_TWO }]);

    const quota = await service.getWeekQuota(_EMPLOYEE_ID, _MONDAY_WEEK_ONE);

    expect(quota.usedDays).toBe(1);
  });
});
