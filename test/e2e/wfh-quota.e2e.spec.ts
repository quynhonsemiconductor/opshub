/**
 * The weekly work-from-home quota, end to end.
 *
 * WHAT THIS PINS. The allowance comes from the RANK of the employee's current role, the week is
 * Monday–Sunday, the quota resets every week and never carries over, and an employee may file only while the
 * allowance is above zero and the days asked for fit the days left. A rejected request gives its days back.
 *
 * The SQL half of this — the join through `employee_roles → roles → rank_benefits` and the
 * pending-or-approved status filter — can only be proven against a real database, which is why this file
 * exists next to the unit tests.
 *
 * The requester is the AUDITOR fixture: any signed-in employee may file WFH for themselves, and no other
 * suite files requests as that employee, so its quota arithmetic is not disturbed by anyone else's rows.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d`, `pnpm db:migrate` and `pnpm db:seed`.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FIXTURE,
  apiRequest,
  createTestApp,
  errorCode,
  login,
  unwrap,
  type Session,
} from './support/harness';
import { mondayAhead, plusDays } from './support/week-dates';
import { giveWeeklyWfhAllowance } from './support/wfh-allowance';

let app: NestFastifyApplication;
let hr: Session;
let requester: Session;

/** Unique per run: rank names and role codes are shared across suites. */
const _RUN_TAG = Date.now().toString(36).slice(-6);

/** How many weeks ahead the test weeks start; far enough to clear the "not in the past" rule. */
const _WEEKS_AHEAD = 6;

interface WeekQuota {
  weekStart: string;
  weekEnd: string;
  weeklyAllowance: number;
  usedDays: number;
  remainingDays: number;
}

async function fileWfh(startDate: string, endDate: string) {
  return apiRequest(app, requester, 'POST', '/workforce/wfh', { startDate, endDate });
}

async function quotaOfWeekContaining(date: string): Promise<WeekQuota> {
  const { status, body } = await apiRequest(
    app,
    requester,
    'GET',
    `/workforce/wfh/quota?weekOf=${date}`,
  );
  expect(status, JSON.stringify(body)).toBe(200);
  return unwrap<WeekQuota>(body);
}

beforeAll(async () => {
  app = await createTestApp();
  hr = await login(app, FIXTURE.HR);
  requester = await login(app, FIXTURE.AUDITOR);
}, 60_000);

afterAll(async () => {
  await app?.close();
});

describe('weekly WFH quota', () => {
  const weekOneMonday = mondayAhead(_WEEKS_AHEAD);
  const weekTwoMonday = plusDays(weekOneMonday, 7);

  it('refuses to file while the employee has no allowance (no ranked role)', async () => {
    const { status, body } = await fileWfh(weekOneMonday, weekOneMonday);

    expect(status).toBe(412);
    expect(errorCode(body)).toBe('WFH_QUOTA_NONE');
  });

  it('refuses to file when the rank carries a zero allowance', async () => {
    await giveWeeklyWfhAllowance(app, hr, FIXTURE.AUDITOR.id, 0, `${_RUN_TAG}0`);

    const { status, body } = await fileWfh(weekOneMonday, weekOneMonday);

    expect(status).toBe(412);
    expect(errorCode(body)).toBe('WFH_QUOTA_NONE');
  });

  it('reports the allowance of the rank once the employee holds a ranked role', async () => {
    await giveWeeklyWfhAllowance(app, hr, FIXTURE.AUDITOR.id, 2, `${_RUN_TAG}2`);

    const quota = await quotaOfWeekContaining(weekOneMonday);

    expect(quota).toMatchObject({
      weekStart: weekOneMonday,
      weeklyAllowance: 2,
      usedDays: 0,
      remainingDays: 2,
    });
  });

  it('lets a request that fits, then refuses a day beyond the week’s allowance', async () => {
    const tuesday = plusDays(weekOneMonday, 1);
    const wednesday = plusDays(weekOneMonday, 2);

    const fits = await fileWfh(weekOneMonday, tuesday);
    expect(fits.status, JSON.stringify(fits.body)).toBe(201);
    expect((await quotaOfWeekContaining(weekOneMonday)).remainingDays).toBe(0);

    const overflow = await fileWfh(wednesday, wednesday);
    expect(overflow.status).toBe(412);
    expect(errorCode(overflow.body)).toBe('WFH_QUOTA_EXCEEDED');
  });

  it('does not carry unused or used days into the next week', async () => {
    const tuesday = plusDays(weekTwoMonday, 1);

    expect((await quotaOfWeekContaining(weekTwoMonday)).remainingDays).toBe(2);
    const nextWeek = await fileWfh(weekTwoMonday, tuesday);

    expect(nextWeek.status, JSON.stringify(nextWeek.body)).toBe(201);
  });

  it('gives the days back when the request is rejected', async () => {
    const wednesday = plusDays(weekOneMonday, 2);
    expect((await quotaOfWeekContaining(weekOneMonday)).remainingDays).toBe(0);

    const list = await apiRequest(
      app,
      hr,
      'GET',
      `/workforce/wfh?employeeId=${FIXTURE.AUDITOR.id}&dateFrom=${weekOneMonday}&dateTo=${plusDays(weekOneMonday, 6)}&limit=50`,
    );
    expect(list.status).toBe(200);
    const pending = unwrap<{ id: string; status: string }[]>(list.body).find(
      (request) => request.status === 'pending',
    );
    expect(pending, 'the week-one request is pending').toBeDefined();

    const review = await apiRequest(app, hr, 'POST', `/workforce/wfh/${pending!.id}/review`, {
      approve: false,
    });
    expect(review.status, JSON.stringify(review.body)).toBeLessThan(300);

    expect((await quotaOfWeekContaining(weekOneMonday)).remainingDays).toBe(2);
    const refiled = await fileWfh(wednesday, wednesday);
    expect(refiled.status, JSON.stringify(refiled.body)).toBe(201);
  });
});
