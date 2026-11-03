/**
 * Work from home, from the request to the day it changes — end to end.
 *
 * WHAT THIS PINS. A day's attendance is DERIVED, never stored: with no door swipes and no approved WFH it is
 * `absent`, 0 minutes, and an approved WFH request is what turns it into `wfh`, 8 hours. So the day is absent
 * for exactly as long as the request is undecided, and "approved before the day" and "approved after it" are
 * the same state change — which is why this needs no clock travel: any working day without swipes reads absent
 * until the approval lands.
 *
 * AND WHO DECIDES. The decider is the general `approver` group, which holds the decision permissions and
 * nothing else: no directory, no contract, no reports. If that group were missing either half of a decision
 * (the route's `workforce.approve` or the engine's `workforce.wfh.review`) the approval below would be
 * refused, so this is also the proof that the group is wired the way its bundle says.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d`, `pnpm db:migrate` and `pnpm db:seed`.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FIXTURE,
  apiRequest,
  authHeaders,
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
let admin: Session;
let approver: Session;
let manager: Session;
let requester: Session;

/** Unique per run: rank names and role codes are shared across suites. */
const _RUN_TAG = Date.now().toString(36).slice(-6);

/** How many weeks ahead the test days are; far from every other suite's weeks and clear of "not in the past". */
const _WEEKS_AHEAD = 10;

/** What a full WFH day is worth in attendance, in minutes (8 hours). */
const _FULL_DAY_MINUTES = 480;

/** The requester's display name in the CSV (`db/seed.ts`, the SECURITY fixture). */
const _REQUESTER_NAME = 'Security Officer';

interface AttendanceDay {
  date: string;
  status: 'holiday' | 'leave' | 'wfh' | 'office' | 'absent';
  workedMinutes: number;
}

interface WfhRow {
  id: string;
  status: string;
}

const monday = mondayAhead(_WEEKS_AHEAD);
const tuesday = plusDays(monday, 1);
const wednesday = plusDays(monday, 2);

/**
 * Files a one-day WFH request as the requester.
 *
 * Args:
 *   day: The `YYYY-MM-DD` day to work from home.
 *
 * Returns:
 *   The id of the request that was created.
 */
async function fileWfh(day: string): Promise<string> {
  const { status, body } = await apiRequest(app, requester, 'POST', '/workforce/wfh', {
    startDate: day,
    endDate: day,
  });
  expect(status, JSON.stringify(body)).toBe(201);
  return unwrap<WfhRow>(body).id;
}

/** The requester's own attendance for the day, as the Attendance screen derives it. */
async function myDay(day: string): Promise<AttendanceDay> {
  const { status, body } = await apiRequest(
    app,
    requester,
    'GET',
    `/workforce/attendance/me?month=${day.slice(0, 7)}`,
  );
  expect(status, JSON.stringify(body)).toBe(200);
  const month = unwrap<{ employees: { days: AttendanceDay[] }[] }>(body);
  const found = month.employees[0]?.days.find((d) => d.date === day);
  if (!found) throw new Error(`${day} is not a working day in the derived month`);
  return found;
}

/** The decision, through the workforce review route the approver group is meant to use. */
async function decide(requestId: string, approve: boolean, note?: string) {
  return apiRequest(app, approver, 'POST', `/workforce/wfh/${requestId}/review`, {
    approve,
    ...(note ? { note } : {}),
  });
}

/** The `wfh_days` column of the requester's row in the month's summary CSV, read as HR. */
async function summaryWfhDays(month: string): Promise<number> {
  const res = await app.inject({
    method: 'GET',
    url: `/v1/workforce/attendance/summary.csv?month=${month}`,
    headers: authHeaders(hr),
  });
  expect(res.statusCode, res.body).toBe(200);
  const row = res.body.split('\n').find((line) => line.startsWith(`${_REQUESTER_NAME},`));
  if (!row) throw new Error(`no ${_REQUESTER_NAME} row in the ${month} summary`);
  // employee,department,office_days,wfh_days,…
  return Number(row.split(',')[3]);
}

beforeAll(async () => {
  app = await createTestApp();
  hr = await login(app, FIXTURE.HR);
  admin = await login(app, FIXTURE.ADMIN);
  approver = await login(app, FIXTURE.APPROVER);
  manager = await login(app, FIXTURE.MANAGER);
  requester = await login(app, FIXTURE.SECURITY);
  // Five days a week: the allowance is not what these tests are about, only that the requester may file.
  await giveWeeklyWfhAllowance(app, hr, FIXTURE.SECURITY.id, 5, `att${_RUN_TAG}`);
}, 60_000);

afterAll(async () => {
  await app?.close();
});

describe('a WFH request and the day it changes', () => {
  it('leaves the day absent, with no hours, for as long as the request is undecided', async () => {
    await fileWfh(monday);

    expect(await myDay(monday)).toMatchObject({ status: 'absent', workedMinutes: 0 });
  });

  it('turns the day into WFH, eight hours, once the general approver group approves it', async () => {
    const requestId = await fileWfh(tuesday);
    expect(await myDay(tuesday)).toMatchObject({ status: 'absent', workedMinutes: 0 });

    const review = await decide(requestId, true);
    expect(review.status, JSON.stringify(review.body)).toBeLessThan(300);

    expect(await myDay(tuesday)).toMatchObject({ status: 'wfh', workedMinutes: _FULL_DAY_MINUTES });
    // Counted in the monthly summary, per working day.
    expect(await summaryWfhDays(tuesday.slice(0, 7))).toBeGreaterThanOrEqual(1);
  });

  it('keeps the approver group to decisions: it can decide, but not read the organisation', async () => {
    // The group's whole point. `GET /employees` needs `employee.read`, which `manager` holds and `approver` does not.
    const directory = await apiRequest(app, approver, 'GET', '/employees?limit=1');
    expect(directory.status).toBe(403);
  });

  it('leaves the day absent when the request is rejected, and says why', async () => {
    const requestId = await fileWfh(wednesday);

    const review = await decide(requestId, false, 'the team is short that day');
    expect(review.status, JSON.stringify(review.body)).toBeLessThan(300);

    expect(await myDay(wednesday)).toMatchObject({ status: 'absent', workedMinutes: 0 });
    const mine = await apiRequest(
      app,
      requester,
      'GET',
      `/workforce/wfh?employeeId=${FIXTURE.SECURITY.id}&dateFrom=${wednesday}&dateTo=${wednesday}`,
    );
    expect(unwrap<WfhRow[]>(mine.body).map((r) => r.status)).toContain('rejected');
  });

  it('refuses a decision once the month is closed, and accepts it after the month is reopened', async () => {
    // A day of its own, in a week no other WFH spec files for (the quota spec uses weeks 6 and 7, the mail spec week
    // 12, this file weeks 10 and 14), so neither the overlap rule nor the month close below touches another test's
    // request. All three file as different people or on different days, but share one database.
    const lateMonday = plusDays(monday, 28);
    const lateMonth = lateMonday.slice(0, 7);
    const requestId = await fileWfh(lateMonday);

    const closed = await apiRequest(
      app,
      hr,
      'POST',
      `/workforce/attendance/months/${lateMonth}/close`,
      {},
    );
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    try {
      const refused = await decide(requestId, true);
      expect(refused.status, JSON.stringify(refused.body)).toBe(412);
      // Undecided, so the day is still absent: nobody could approve it while the month was locked.
      expect(await myDay(lateMonday)).toMatchObject({ status: 'absent', workedMinutes: 0 });
    } finally {
      const reopened = await apiRequest(
        app,
        admin,
        'POST',
        `/workforce/attendance/months/${lateMonth}/reopen`,
        { note: 'e2e: wfh-attendance cleanup' },
      );
      expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
    }

    const accepted = await decide(requestId, true);
    expect(accepted.status, JSON.stringify(accepted.body)).toBeLessThan(300);
    expect(await myDay(lateMonday)).toMatchObject({
      status: 'wfh',
      workedMinutes: _FULL_DAY_MINUTES,
    });
  });

  it('pins a request to the requester’s manager: the approver group may not decide it, the manager may', async () => {
    /*
     * WHAT THE GENERAL GROUP DOES AND DOES NOT DO. A ticket is decided by its ASSIGNEE: when the requester's
     * manager is active and holds `workforce.wfh.review`, the engine names them and refuses every other holder
     * while they are available (a delegate, or HR/admin when they are not, excepted). So `approver` decides the
     * tickets that have NO named assignee — a requester without a manager, or whose manager lacks the review
     * permission — and not the tickets of people who have a qualifying manager. Asserted so that nobody reads the
     * group as a way to take decisions away from a manager.
     */
    const setManager = (managerId: string | null) =>
      apiRequest(app, admin, 'PATCH', `/employees/${FIXTURE.SECURITY.id}`, { managerId });
    const pinned = await setManager(FIXTURE.MANAGER.id);
    expect(pinned.status, JSON.stringify(pinned.body)).toBeLessThan(300);
    try {
      const requestId = await fileWfh(plusDays(monday, 4));

      const asApprover = await decide(requestId, true);
      expect(asApprover.status, JSON.stringify(asApprover.body)).toBe(403);
      expect(JSON.stringify(asApprover.body)).toMatch(/waiting on/);

      const asManager = await apiRequest(
        app,
        manager,
        'POST',
        `/workforce/wfh/${requestId}/review`,
        {
          approve: true,
        },
      );
      expect(asManager.status, JSON.stringify(asManager.body)).toBeLessThan(300);
    } finally {
      await setManager(null);
    }
  });

  it('refuses a decision from someone who holds no review permission', async () => {
    const requestId = await fileWfh(plusDays(monday, 3));

    const asEmployee = await login(app, FIXTURE.NO_PERMISSIONS);
    const refused = await apiRequest(
      app,
      asEmployee,
      'POST',
      `/workforce/wfh/${requestId}/review`,
      {
        approve: true,
      },
    );

    expect(refused.status).toBe(403);
    expect(errorCode(refused.body)).toBeDefined();
  });
});
