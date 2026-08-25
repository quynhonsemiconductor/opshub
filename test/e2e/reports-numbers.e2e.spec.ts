/**
 * THE REPORTS ENDPOINTS RETURN NUMBERS. That sounds too obvious to test, and it was not true.
 *
 * WHAT THIS EXISTS TO PIN. Every aggregate in `ReportsService` is written as `sql<number>` over a
 * `round(...)::numeric` or a `percentile_cont`. That is an assertion about the TypeScript type, not a
 * coercion: the driver returns `numeric` as a STRING. The assertion then flows into the OpenAPI spec
 * and the generated client, so the SPA was told `number` and handed `"12.00"`.
 *
 * The consequence was not cosmetic. The Reports page sums the overtime rows, and summing strings
 * CONCATENATES them — `"12.00"` and `"8.50"` reduce to `"012.008.50"`, and `Math.round` of that is
 * `NaN`, which is what the tile rendered. It survived because a single row happens to work, and
 * overtime is grouped by status, so two rows is the ordinary case rather than the edge one.
 *
 * SO THE ASSERTIONS ARE ON `typeof`, not on a value. A test that checked the arithmetic would pass on
 * a one-row database — exactly the condition that hid this. And there was no reports spec at all;
 * this file is the first.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d` and `pnpm db:migrate`.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE, apiRequest, createTestApp, login, unwrap, type Session } from './support/harness';

let app: NestFastifyApplication;
/** Holds `reports.read`. */
let reader: Session;
/** Files the overtime, so there is something to aggregate. */
let employee: Session;
/** Decides it, so the rows land in more than one status bucket — the case that broke. */
let approver: Session;

beforeAll(async () => {
  app = await createTestApp();
  reader = await login(app, FIXTURE.ADMIN);
  employee = await login(app, FIXTURE.NO_PERMISSIONS);
  approver = await login(app, FIXTURE.HR);
});

afterAll(async () => {
  await app?.close();
});

interface OvertimeRow {
  status: string;
  count: number;
  totalHours: number;
  avgHours: number;
}

/** Log overtime as the employee and return its id. */
async function logOvertime(hours: number, reason: string): Promise<string> {
  const res = await apiRequest(app, employee, 'POST', '/workforce/overtime', {
    // `workDate`, not `workedOn` — my first draft guessed and got a 422 naming the field.
    workDate: '2027-03-15',
    hours,
    reason,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return unwrap<{ id: string }>(res.body).id;
}

describe('the overtime summary', () => {
  it('returns hours as JSON numbers, in every status bucket', async () => {
    /*
     * TWO BUCKETS ON PURPOSE. One pending and one decided, because the defect is invisible with a
     * single row: `Math.round("012.00")` is 12 and looks correct. It is the second row that turns the
     * sum into concatenation.
     */
    const pending = await logOvertime(3, 'e2e: stays pending so one bucket has a row');
    const decided = await logOvertime(2.5, 'e2e: gets approved so a second bucket exists');
    expect(pending).not.toBe(decided);

    const reviewed = await apiRequest(
      app,
      approver,
      'POST',
      `/workforce/overtime/${decided}/review`,
      {
        approve: true,
      },
    );
    expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(201);

    const res = await apiRequest(app, reader, 'GET', '/reports/workforce/overtime');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rows = unwrap<{ rows: OvertimeRow[] }>(res.body).rows;

    expect(rows.length, 'no overtime aggregated, so the types below prove nothing').toBeGreaterThan(
      1,
    );
    for (const row of rows) {
      expect(
        typeof row.totalHours,
        `totalHours came back as ${typeof row.totalHours} for status ${row.status} — summing these concatenates`,
      ).toBe('number');
      expect(typeof row.avgHours).toBe('number');
      expect(typeof row.count).toBe('number');
    }

    /*
     * AND THE ARITHMETIC THE TILE ACTUALLY DOES. Asserted as well as the types, because that is the
     * failure a reader recognises: this reduce is the one that produced `NaN` on screen.
     */
    const total = rows.reduce((sum, r) => sum + r.totalHours, 0);
    expect(Number.isFinite(total), `summing the rows produced ${total}`).toBe(true);
    expect(total).toBeGreaterThan(0);
  });
});

describe('the cycle-time report', () => {
  it('returns its percentiles as JSON numbers', async () => {
    /*
     * `percentile_cont` is `numeric` too, and its three fields feed a chart rather than a sum — so a
     * string there does not crash, it silently sorts and scales as text. That is worse than `NaN`,
     * which at least announces itself.
     *
     * A RESOLVED REQUEST IS CREATED HERE. The report groups requests that have a `resolvedAt` inside
     * the window, and the suite truncates the database, so reading "whatever happens to be there"
     * returned nothing and the loop asserted nothing — a green test over an empty set, which is the
     * shape of failure this whole file is about.
     */
    const leave = await apiRequest(app, employee, 'POST', '/workforce/leave', {
      leaveType: 'annual',
      startDate: '2027-04-05',
      endDate: '2027-04-06',
      reason: 'e2e: resolved so the cycle-time report has a row',
    });
    expect(leave.status, JSON.stringify(leave.body)).toBe(201);
    const decided = await apiRequest(
      app,
      approver,
      'POST',
      `/workforce/leave/${unwrap<{ id: string }>(leave.body).id}/review`,
      { approve: true },
    );
    expect(decided.status, JSON.stringify(decided.body)).toBe(201);

    const res = await apiRequest(app, reader, 'GET', '/reports/requests/cycle-time');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rows = unwrap<{ rows: { avgHours: number; p50Hours: number; p90Hours: number }[] }>(
      res.body,
    ).rows;

    expect(
      rows.length,
      'no resolved requests in the window, so nothing was typed here',
    ).toBeGreaterThan(0);
    for (const row of rows) {
      expect(typeof row.avgHours).toBe('number');
      expect(typeof row.p50Hours).toBe('number');
      expect(typeof row.p90Hours).toBe('number');
    }
  });
});
