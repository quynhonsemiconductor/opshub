/**
 * Leave entitlement, balances and the holiday calendar, end to end.
 *
 * WHAT THIS EXISTS TO PIN
 * -----------------------
 * Leave used to be approvable without anyone knowing what it cost: `leave_requests` held two dates
 * and nothing else. The rules added here are all invisible from a single request row, so each one
 * needs a flow to prove it:
 *
 *   - a request costs WORKING days — weekends and public holidays excluded
 *   - that cost is FROZEN at submit, so a holiday declared later does not restate it
 *   - PENDING requests count against the balance, or an employee with two days left can file four
 *     two-day requests before anyone approves the first
 *   - a leave type with no entitlement row is UNTRACKED, not zero-allowance
 *   - only `workforce.manage` may change an allowance or the calendar
 *
 * Named by the `@AuthorizedInService(..., 'leave-balance.e2e.spec.ts')` declaration on
 * `GET /workforce/leave/balance`, which is a promise that this file asserts both directions.
 *
 * DATES ARE FAR IN THE FUTURE AND UNIQUE PER RUN. The database is shared with the other suites and
 * is not reset between them; `hasOverlappingLeave` refuses a second request across the same dates,
 * so fixed dates make a spec that passes once. The same mistake cost a debugging round in the
 * Playwright leave journey.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d` and `pnpm db:migrate`.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE, authHeaders, createTestApp, login, type Session } from './support/harness';

let app: NestFastifyApplication;
/** Holds NO permission codes — the tier every rule here must constrain. */
let employee: Session;
/** Holds `workforce.manage` and `workforce.read`. */
let hr: Session;

/**
 * A distinct year per run, so balances and holidays cannot collide with another run's rows.
 *
 * Years rather than dates because a balance is scoped by year: two runs in the same year would
 * share a consumed total and the arithmetic assertions would depend on execution order.
 */
const YEAR = 2040 + (Math.floor(Date.now() / 1000) % 40);

/** The Monday of the first full week of a month in YEAR, as `YYYY-MM-DD`. */
function mondayIn(month: number): string {
  for (let day = 1; day <= 14; day++) {
    const d = new Date(Date.UTC(YEAR, month - 1, day));
    if (d.getUTCDay() === 1) return d.toISOString().slice(0, 10);
  }
  throw new Error('no Monday found');
}

/** `date` shifted by `days`, as `YYYY-MM-DD`. */
function plusDays(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

async function balances(
  session: Session,
  query = '',
): Promise<
  {
    leaveType: string;
    grantedDays: number;
    accruedDays: number;
    carriedOverDays: number;
    carriedOverExpiresOn: string | null;
    carriedOverAvailable: boolean;
    consumedDays: number;
    availableDays: number;
    remainingDays: number;
  }[]
> {
  const res = await app.inject({
    method: 'GET',
    url: `/v1/workforce/leave/balance?year=${YEAR}${query}`,
    headers: authHeaders(session),
  });
  expect(res.statusCode, res.body).toBe(200);
  return JSON.parse(res.body) as never;
}

async function submitLeave(
  session: Session,
  start: string,
  end: string,
  leaveType = 'annual',
  portions: { startPortion?: string; endPortion?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/workforce/leave',
    headers: authHeaders(session),
    payload: {
      leaveType,
      startDate: start,
      endDate: end,
      reason: `e2e ${start}`,
      // Spread rather than defaulted to 'full_day': a request that says NOTHING about portions has
      // to keep working, and that is what most of this suite sends.
      ...portions,
    },
  });
  return { status: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown> };
}

beforeAll(async () => {
  app = await createTestApp();
  employee = await login(app, FIXTURE.NO_PERMISSIONS);
  hr = await login(app, FIXTURE.HR);
});

afterAll(async () => {
  await app?.close();
});

describe('leave entitlement and balances', () => {
  it('grants an allowance and reports it as a balance', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/workforce/leave/entitlement',
      headers: authHeaders(hr),
      payload: {
        employeeId: FIXTURE.NO_PERMISSIONS.id,
        leaveType: 'annual',
        year: YEAR,
        grantedDays: 10,
      },
    });
    expect(res.statusCode, res.body).toBe(204);

    const [annual] = await balances(employee);
    expect(annual).toMatchObject({
      leaveType: 'annual',
      grantedDays: 10,
      consumedDays: 0,
      remainingDays: 10,
    });
  });

  it('charges working days only, excluding a mid-week public holiday', async () => {
    const monday = mondayIn(6);
    const wednesday = plusDays(monday, 2);

    const holiday = await app.inject({
      method: 'POST',
      url: '/v1/workforce/holidays',
      headers: authHeaders(hr),
      payload: { date: wednesday, name: `E2E holiday ${YEAR}` },
    });
    expect(holiday.statusCode, holiday.body).toBe(201);

    // Mon–Fri is five weekdays; one of them is now a holiday.
    const { status, body } = await submitLeave(employee, monday, plusDays(monday, 4));
    expect(status, JSON.stringify(body)).toBe(201);
    expect(body.workingDays, 'the holiday was not excluded from the charge').toBe(4);

    const [annual] = await balances(employee);
    expect(annual.consumedDays).toBe(4);
    expect(annual.remainingDays).toBe(6);
  });

  it('counts a PENDING request against the balance', async () => {
    // Nothing has been approved — the previous request is still pending — so a balance that only
    // counted approvals would still read 10 remaining and let the employee spend it twice.
    const [annual] = await balances(employee);
    expect(annual.consumedDays).toBeGreaterThan(0);
    expect(annual.remainingDays).toBe(annual.grantedDays - annual.consumedDays);
  });

  it('does NOT restate an existing request when a holiday is declared later', async () => {
    const monday = mondayIn(9);
    const { status, body } = await submitLeave(employee, monday, plusDays(monday, 1));
    expect(status, JSON.stringify(body)).toBe(201);
    expect(body.workingDays).toBe(2);

    // Declare a holiday INSIDE the window that was just booked.
    const holiday = await app.inject({
      method: 'POST',
      url: '/v1/workforce/holidays',
      headers: authHeaders(hr),
      payload: { date: monday, name: `Retro holiday ${YEAR}` },
    });
    expect(holiday.statusCode, holiday.body).toBe(201);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/workforce/leave?employeeId=${FIXTURE.NO_PERMISSIONS.id}&limit=50`,
      headers: authHeaders(hr),
    });
    expect(res.statusCode).toBe(200);
    const rows = (JSON.parse(res.body) as { data: { startDate: string; workingDays: number }[] })
      .data;
    const booked = rows.find((r) => r.startDate === monday);

    expect(
      booked?.workingDays,
      'the charge changed after a holiday was declared inside an already-booked window — ' +
        'working_days must be frozen at submit',
    ).toBe(2);
  });

  it('refuses a request the employee cannot afford', async () => {
    // 10 granted, and the earlier tests consumed most of it.
    const [annual] = await balances(employee);
    const monday = mondayIn(11);
    const tooLong = plusDays(monday, 4 + 7 * (annual.remainingDays + 1));

    const { status, body } = await submitLeave(employee, monday, tooLong);
    expect(status, JSON.stringify(body)).toBe(412);
    expect((body.error as { code: string }).code).toBe('LEAVE_INSUFFICIENT_BALANCE');
  });

  it('refuses a window containing no working days', async () => {
    const monday = mondayIn(4);
    const saturday = plusDays(monday, 5);

    const { status, body } = await submitLeave(employee, saturday, plusDays(saturday, 1));
    expect(status, JSON.stringify(body)).toBe(412);
    expect((body.error as { code: string }).code).toBe('LEAVE_NO_WORKING_DAYS');
  });

  it('leaves an UNTRACKED leave type unconstrained', async () => {
    // No entitlement row for `unpaid`, which must mean "not tracked" rather than "zero days" —
    // otherwise every unpaid request is refused.
    const monday = mondayIn(7);
    const { status, body } = await submitLeave(employee, monday, plusDays(monday, 4), 'unpaid');

    expect(status, JSON.stringify(body)).toBe(201);
    expect(body.workingDays).toBe(5);
    // And it does not appear as a balance, because there is no allowance to report.
    expect((await balances(employee)).map((b) => b.leaveType)).not.toContain('unpaid');
  });
});

describe('part-day leave', () => {
  /**
   * November's first Monday, the week these windows are laid out from.
   *
   * The earlier "cannot afford" test also names this Monday, but it is REFUSED, so it leaves no row
   * to collide with. Every offset below is a multiple of 7 (plus 2 for the Wednesday case), so each
   * window lands on the weekday its assertion assumes whatever `YEAR` resolves to.
   */
  const week = mondayIn(11);

  beforeAll(async () => {
    // Raise the allowance: the earlier tests deliberately consumed nearly all of 10 days, and these
    // windows total nine. Set AFTER those assertions have run, which is why it is here and not in
    // the file's own beforeAll.
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/workforce/leave/entitlement',
      headers: authHeaders(hr),
      payload: {
        employeeId: FIXTURE.NO_PERMISSIONS.id,
        leaveType: 'annual',
        year: YEAR,
        grantedDays: 60,
      },
    });
    expect(res.statusCode, res.body).toBe(204);
  });

  it('charges half a day for a lone afternoon, and reports the portions back', async () => {
    const res = await submitLeave(employee, week, week, 'annual', {
      startPortion: 'afternoon',
      endPortion: 'afternoon',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      startPortion: 'afternoon',
      endPortion: 'afternoon',
      workingDays: 0.5,
    });
  });

  it('lets the morning of that same day be booked separately', async () => {
    // A MORNING AND AN AFTERNOON ON THE SAME DATE DO NOT OVERLAP. The date-range test alone would
    // refuse this, and refusing leave the employee can see is free is worse than no check.
    const res = await submitLeave(employee, week, week, 'annual', {
      startPortion: 'morning',
      endPortion: 'morning',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ workingDays: 0.5 });
  });

  it('refuses a third request for a half already taken', async () => {
    const res = await submitLeave(employee, week, week, 'annual', {
      startPortion: 'morning',
      endPortion: 'morning',
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { code: 'LEAVE_OVERLAPPING' } });
  });

  it('charges two days for Wednesday afternoon through Friday morning', async () => {
    // Half of Wednesday, all of Thursday, half of Friday.
    const wednesday = plusDays(week, 9);
    const res = await submitLeave(employee, wednesday, plusDays(wednesday, 2), 'annual', {
      startPortion: 'afternoon',
      endPortion: 'morning',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ workingDays: 2 });
  });

  it('lets the next window begin in the afternoon the previous one ended at midday', async () => {
    // Touching, not overlapping: Monday to Wednesday morning, then Wednesday afternoon onward.
    const monday = plusDays(week, 21);
    const wednesday = plusDays(monday, 2);
    const first = await submitLeave(employee, monday, wednesday, 'annual', {
      endPortion: 'morning',
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({ workingDays: 2.5 });

    const second = await submitLeave(employee, wednesday, plusDays(wednesday, 1), 'annual', {
      startPortion: 'afternoon',
    });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(second.body).toMatchObject({ workingDays: 1.5 });
  });

  it('moves the balance by exactly half a day', async () => {
    // `numeric(5,2)` throughout, so a balance made of halves is exact rather than rounded — the
    // reason part-day leave needed no new column at all.
    //
    // Measured as a DELTA around one booking rather than asserted against the running total: the
    // total is whatever the tests before it consumed, and two halves that happen to pair into a
    // whole would make an assertion about its fractional part pass or fail by accident.
    const before = (await balances(employee)).find((b) => b.leaveType === 'annual')!;

    const day = mondayIn(3);
    const res = await submitLeave(employee, day, day, 'annual', {
      startPortion: 'morning',
      endPortion: 'morning',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const after = (await balances(employee)).find((b) => b.leaveType === 'annual')!;
    expect(after.consumedDays - before.consumedDays).toBe(0.5);
    expect(before.availableDays - after.availableDays).toBe(0.5);
  });

  it('refuses morning-to-afternoon, because that is what full_day is for', async () => {
    const day = plusDays(week, 28);
    const res = await submitLeave(employee, day, day, 'annual', {
      startPortion: 'morning',
      endPortion: 'afternoon',
    });
    expect(res.status).toBe(412);
    expect(res.body).toMatchObject({ error: { code: 'LEAVE_INVALID_WINDOW' } });
  });

  it('refuses a multi-day window starting with a lone morning', async () => {
    const day = plusDays(week, 35);
    const res = await submitLeave(employee, day, plusDays(day, 2), 'annual', {
      startPortion: 'morning',
    });
    expect(res.status).toBe(412);
    expect(res.body).toMatchObject({ error: { code: 'LEAVE_INVALID_WINDOW' } });
  });

  it('refuses a multi-day window ending with a lone afternoon', async () => {
    const day = plusDays(week, 42);
    const res = await submitLeave(employee, day, plusDays(day, 2), 'annual', {
      endPortion: 'afternoon',
    });
    expect(res.status).toBe(412);
    expect(res.body).toMatchObject({ error: { code: 'LEAVE_INVALID_WINDOW' } });
  });

  it('refuses an afternoon that falls on a weekend, because it costs nothing', async () => {
    // Reaches the existing zero-cost refusal rather than a part-day rule: the day it is half of
    // costs nothing, so the half costs nothing.
    const saturday = plusDays(week, 47);
    const res = await submitLeave(employee, saturday, saturday, 'annual', {
      startPortion: 'afternoon',
      endPortion: 'afternoon',
    });
    expect(res.status).toBe(412);
    expect(res.body).toMatchObject({ error: { code: 'LEAVE_NO_WORKING_DAYS' } });
  });

  it('books whole days when the caller says nothing about portions', async () => {
    // The compatibility promise: every request in the rest of this suite is one of these.
    const monday = plusDays(week, 49);
    const res = await submitLeave(employee, monday, plusDays(monday, 1));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      startPortion: 'full_day',
      endPortion: 'full_day',
      workingDays: 2,
    });
  });
});

describe('accrual and carry-over', () => {
  /** Set an allowance for a year, so each test can pick its own without colliding. */
  async function grant(year: number, days: number, leaveType = 'annual'): Promise<void> {
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/workforce/leave/entitlement',
      headers: authHeaders(hr),
      payload: { employeeId: FIXTURE.NO_PERMISSIONS.id, leaveType, year, grantedDays: days },
    });
    expect(res.statusCode, res.body).toBe(204);
  }

  async function balancesFor(year: number) {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/workforce/leave/balance?year=${year}`,
      headers: authHeaders(employee),
    });
    expect(res.statusCode, res.body).toBe(200);
    return JSON.parse(res.body) as Awaited<ReturnType<typeof balances>>;
  }

  it('publishes a policy per leave type, marking the ones nobody configured', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/workforce/leave/policies',
      headers: authHeaders(hr),
    });
    expect(res.statusCode, res.body).toBe(200);
    const policies = JSON.parse(res.body) as {
      leaveType: string;
      accrualMethod: string;
      carryOverMaxDays: number;
      isDefault: boolean;
    }[];

    const byType = Object.fromEntries(policies.map((p) => [p.leaveType, p]));
    // Seeded: annual earns monthly and carries five days; sick is available in full and carries none.
    expect(byType.annual).toMatchObject({
      accrualMethod: 'monthly_accrual',
      carryOverMaxDays: 5,
      isDefault: false,
    });
    expect(byType.sick).toMatchObject({ accrualMethod: 'annual_grant', isDefault: false });
    // Untracked types have NO row, and that absence is a meaning rather than a gap — so they appear
    // with the pre-accrual default and say so.
    expect(byType.unpaid).toMatchObject({
      accrualMethod: 'annual_grant',
      carryOverMaxDays: 0,
      isDefault: true,
    });
  });

  it('distinguishes the two accrual methods WITHIN the current year', async () => {
    // The methods differ over the course of a year, which is the only place the difference exists:
    // annual leave is earned a twelfth per month, sick leave is available in full from January.
    const year = new Date().getUTCFullYear();
    const month = new Date().getUTCMonth() + 1;
    await grant(year, 12);
    await grant(year, 8, 'sick');
    const now = await balancesFor(year);

    // A 12-day grant earns exactly one day per month, so today's month IS the accrued figure.
    const annual = now.find((b) => b.leaveType === 'annual')!;
    expect(annual.accruedDays).toBe(month);
    // The whole allowance for the year is still reported, whatever is earned so far.
    expect(annual.grantedDays).toBe(12);
    expect(now.find((b) => b.leaveType === 'sick')!.accruedDays).toBe(8);
  });

  it('treats a finished year as fully earned and a future one as earning nothing YET', async () => {
    // A year in the PAST is fully earned under either method: the year finished.
    const past = 2020;
    await grant(past, 12);
    await grant(past, 8, 'sick');
    const settled = await balancesFor(past);
    expect(settled.find((b) => b.leaveType === 'annual')!.accruedDays).toBe(12);
    expect(settled.find((b) => b.leaveType === 'sick')!.accruedDays).toBe(8);

    // A future year has earned nothing AS OF TODAY under either method — an annual grant is
    // available from the first day of ITS year, not before it. So `accruedDays` for a future year is
    // 0 for every type, and the balance screen for next year reads as a plan rather than a wallet.
    const future = new Date().getUTCFullYear() + 3;
    await grant(future, 12);
    await grant(future, 8, 'sick');
    const ahead = await balancesFor(future);
    for (const leaveType of ['annual', 'sick']) {
      const row = ahead.find((b) => b.leaveType === leaveType)!;
      expect(row.accruedDays, leaveType).toBe(0);
      expect(row.availableDays, leaveType).toBe(0);
    }
    // …while `remainingDays` still reports what the year will settle at, so one screen can show both.
    expect(ahead.find((b) => b.leaveType === 'annual')!.remainingDays).toBe(12);
    // And booking INSIDE that year is still allowed, because accrual is judged at the window's end
    // rather than today — the next test.
  });

  it('allows an advance booking whose days will have accrued by then', async () => {
    // ACCRUAL LIMITS WHAT MAY BE TAKEN, NOT WHEN IT MAY BE BOOKED. Judging accrual today would refuse
    // every future request, which is not what earning leave monthly means.
    const year = new Date().getUTCFullYear() + 4;
    await grant(year, 12);

    // December of that year: twelve twelfths earned by then, so a five-day request is fine even
    // though nothing is accrued today.
    const december = `${year}-12-07`;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/workforce/leave',
      headers: authHeaders(employee),
      payload: {
        leaveType: 'annual',
        startDate: december,
        endDate: `${year}-12-11`,
        reason: 'e2e advance booking',
      },
    });
    expect(res.statusCode, res.body).toBe(201);
  });

  it('refuses a booking for days that will NOT have accrued by then', async () => {
    // January of a monthly-accrued year has earned one twelfth, so a five-day request is refused —
    // and the message says why, because "1 available" against a 12-day allowance is otherwise
    // indistinguishable from a bug.
    const year = new Date().getUTCFullYear() + 5;
    await grant(year, 12);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/workforce/leave',
      headers: authHeaders(employee),
      payload: {
        leaveType: 'annual',
        startDate: `${year}-01-05`,
        endDate: `${year}-01-09`,
        reason: 'e2e unearned booking',
      },
    });
    expect(res.statusCode).toBe(412);
    const body = JSON.parse(res.body) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('LEAVE_INSUFFICIENT_BALANCE');
    expect(body.error.message).toContain('accrued');
  });

  it('carries unused days forward, capped by the policy, with an expiry date', async () => {
    const from = 2021;
    const to = 2022;
    // Nine days unused last year, but the annual policy caps carry-over at five.
    await grant(from, 9);
    await grant(to, 12);

    const run = await app.inject({
      method: 'POST',
      url: '/v1/workforce/leave/carry-over',
      headers: authHeaders(hr),
      payload: { year: to },
    });
    expect(run.statusCode, run.body).toBe(200);

    const target = (await balancesFor(to)).find((b) => b.leaveType === 'annual')!;
    expect(target.carriedOverDays, 'capped at the policy maximum').toBe(5);
    // Six months into the year, meaning THROUGH June rather than until 1 July.
    expect(target.carriedOverExpiresOn).toBe(`${to}-06-30`);
    // Both years are in the past, so the carried days have long lapsed and do not count today.
    expect(target.carriedOverAvailable).toBe(false);
    expect(target.availableDays).toBe(12 - target.consumedDays);
    // `remainingDays` still shows what the year settled at, carried days included.
    expect(target.remainingDays).toBe(17 - target.consumedDays);
  });

  it('is idempotent — a second run lands on the same figure', async () => {
    // It SETS the carried figure from last year's closing balance rather than adding to it. An
    // additive run would double every balance the second time somebody clicked the button.
    const from = 2023;
    const to = 2024;
    await grant(from, 4);
    await grant(to, 12);

    for (const attempt of [1, 2, 3]) {
      const run = await app.inject({
        method: 'POST',
        url: '/v1/workforce/leave/carry-over',
        headers: authHeaders(hr),
        payload: { year: to },
      });
      expect(run.statusCode, `attempt ${attempt}: ${run.body}`).toBe(200);
    }
    const target = (await balancesFor(to)).find((b) => b.leaveType === 'annual')!;
    expect(target.carriedOverDays).toBe(4);
  });

  it('carries nothing for a type whose policy forbids it', async () => {
    const from = 2025;
    const to = 2026;
    await grant(from, 8, 'sick');
    await grant(to, 8, 'sick');

    await app.inject({
      method: 'POST',
      url: '/v1/workforce/leave/carry-over',
      headers: authHeaders(hr),
      payload: { year: to },
    });
    const target = (await balancesFor(to)).find((b) => b.leaveType === 'sick')!;
    // An unused sick allowance is not a saving.
    expect(target.carriedOverDays).toBe(0);
    expect(target.carriedOverExpiresOn).toBeNull();
  });

  it('reports an employee with no entitlement row for the target year instead of inventing one', async () => {
    // The new year's allowance is HR's decision; a row created here with a zero grant would read as
    // an entitlement of nothing.
    const from = 2018;
    const to = 2019;
    await grant(from, 9);

    const run = await app.inject({
      method: 'POST',
      url: '/v1/workforce/leave/carry-over',
      headers: authHeaders(hr),
      payload: { year: to },
    });
    expect(run.statusCode, run.body).toBe(200);
    const result = JSON.parse(run.body) as {
      applied: { employeeId: string }[];
      skippedNoTargetRow: { employeeId: string; days: number }[];
    };
    const skipped = result.skippedNoTargetRow.find(
      (r) => r.employeeId === FIXTURE.NO_PERMISSIONS.id,
    );
    expect(skipped, 'the missing target row must be reported').toBeDefined();
    expect(skipped!.days).toBe(5);
    expect(await balancesFor(to)).toEqual([]);
  });

  it('refuses the carry-over run to an identity without workforce.manage', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/workforce/leave/carry-over',
      headers: authHeaders(employee),
      payload: { year: 2030 },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('leave policy authorization', () => {
  it('refuses an employee setting their own allowance', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/workforce/leave/entitlement',
      headers: authHeaders(employee),
      payload: {
        employeeId: FIXTURE.NO_PERMISSIONS.id,
        leaveType: 'annual',
        year: YEAR,
        grantedDays: 999,
      },
    });
    expect(res.statusCode, res.body).toBe(403);
  });

  it('refuses an employee declaring a public holiday', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/workforce/holidays',
      headers: authHeaders(employee),
      payload: { date: `${YEAR}-12-25`, name: 'Self-declared day off' },
    });
    expect(res.statusCode, res.body).toBe(403);
  });

  it('lets any authenticated employee READ the holiday calendar', async () => {
    // SharedRead: unowned reference data. Gating it behind a permission would hide the calendar
    // from everyone who needs to plan around it, since the `employee` tier holds no codes.
    const res = await app.inject({
      method: 'GET',
      url: `/v1/workforce/holidays?year=${YEAR}`,
      headers: authHeaders(employee),
    });
    expect(res.statusCode, res.body).toBe(200);
  });

  it("refuses an employee reading another employee's balance", async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/workforce/leave/balance?year=${YEAR}&employeeId=${FIXTURE.HR.id}`,
      headers: authHeaders(employee),
    });

    // Denied, NOT silently narrowed to their own numbers — a plausible page of the wrong person's
    // data is indistinguishable from "that person has none".
    expect(res.statusCode, res.body).toBe(403);
  });

  it("lets a workforce.read holder see another employee's balance", async () => {
    const rows = await balances(hr, `&employeeId=${FIXTURE.NO_PERMISSIONS.id}`);
    expect(rows.some((b) => b.leaveType === 'annual')).toBe(true);
  });
});
