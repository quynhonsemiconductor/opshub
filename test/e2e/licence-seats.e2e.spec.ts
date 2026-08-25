/**
 * WHO HOLDS A PAID SEAT — the licence seat list, by name.
 *
 * WHY THIS FILE EXISTS. `GET /v1/licenses/:id/assignments` is the list somebody opens to decide whose
 * seat to reclaim: every active row is money leaving every month, so the only question asked of it is
 * "does this person still need this". The panel rendered `employeeId` on every line, which answers
 * that question with thirty-six characters that identify nobody — and seats had no API-level e2e
 * spec at all. `apps/web/e2e/licence-seats.e2e.ts` drives the panel in a browser, but it asserts on
 * capacity, cost and the soft revoke; nothing pinned what the API returns per row.
 *
 * WHY THE NAME IS NULLABLE AND THE ROW IS NOT. A revoked seat is the row a vendor true-up reconciles
 * against an invoice, so it has to outlive the person who held it. The name is resolved with a left
 * lookup for exactly that reason, and losing the seat record along with a leaver's directory row
 * would be a far worse failure than showing no name.
 *
 * WHY THE WRITE IS ASSERTED TOO, in the negative. `POST .../assignments` hands the row back to a
 * caller who just supplied the employee id, so resolving it there would spend a directory query to
 * restate the request. The SPA discards that response and refetches. That asymmetry is deliberate,
 * so it is pinned rather than left to be "fixed" for consistency later.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d` and `pnpm db:migrate`.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE, apiRequest, createTestApp, login, unwrap, type Session } from './support/harness';

let app: NestFastifyApplication;
/** Holds `license.read` AND `license.manage` — the tier that hands seats out. */
let admin: Session;

const RUN = Date.now().toString(36).toUpperCase().slice(-6);
let seq = 0;

beforeAll(async () => {
  app = await createTestApp();
  admin = await login(app, FIXTURE.ADMIN);
}, 60_000);

afterAll(async () => {
  await app?.close();
});

interface SeatRow {
  id: string;
  employeeId: string;
  /** Resolved server-side on the list read. Null only when the employee row is gone. */
  employeeName: string | null;
  revokedAt: string | null;
  notes: string | null;
}

/** A licence nobody else is using, metered so the seat cap is exercised rather than bypassed. */
async function createLicense(seatCount: number): Promise<string> {
  const res = await apiRequest(app, admin, 'POST', '/licenses', {
    name: `E2E Seat Suite ${RUN}-${++seq}`,
    vendor: 'Acme Creative',
    licenseType: 'subscription',
    seatCount,
    costPerSeatCents: 2400,
    renewalDate: '2027-06-30',
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return unwrap<{ id: string }>(res.body).id;
}

async function assignSeat(licenseId: string, employeeId: string, notes: string): Promise<SeatRow> {
  const res = await apiRequest(app, admin, 'POST', `/licenses/${licenseId}/assignments`, {
    employeeId,
    notes,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return unwrap<SeatRow>(res.body);
}

const seats = async (licenseId: string, includeRevoked = false): Promise<SeatRow[]> =>
  unwrap<SeatRow[]>(
    (
      await apiRequest(
        app,
        admin,
        'GET',
        `/licenses/${licenseId}/assignments?includeRevoked=${includeRevoked}`,
      )
    ).body,
  );

interface UtilRow {
  licenseId: string;
  status: string;
  seatCount: number | null;
  usedSeats: number;
  committedSpendCents: number | null;
  assignedSpendCents: number | null;
}

describe('the utilisation report', () => {
  /*
   * THE NUMBER THE FINOPS PAGE IS READ FOR. There used to be one spend figure, `monthlySpendCents`,
   * computed as `usedSeats × unit cost` — the cost of the seats somebody is sitting in — and the tile
   * summed it under the label "Monthly spend" while the table two inches below computed
   * `seatCount × unit cost` from the same row. One screen, two answers, and the tile was the smaller
   * one: on the seeded register it showed roughly six per cent of what is actually invoiced, so 162
   * paid-for idle seats were invisible on the page whose job is to find them.
   *
   * The gap between the two is the waste, which is why both are returned and named.
   */
  it('reports committed spend separately from the part in use', async () => {
    // 10 seats at 2400 cents; two of them assigned.
    const licenseId = await createLicense(10);
    // Seeded fixtures, as everywhere else in this file: a fresh licence means the seats are free.
    await assignSeat(licenseId, FIXTURE.NO_PERMISSIONS.id, 'e2e: idle-spend arithmetic');
    await assignSeat(licenseId, FIXTURE.MANAGER.id, 'e2e: idle-spend arithmetic');

    const res = await apiRequest(app, admin, 'GET', '/licenses/utilization');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = unwrap<UtilRow[]>(res.body).find((r) => r.licenseId === licenseId);
    expect(row, 'the licence under test is missing from the utilisation report').toBeDefined();

    expect(row!.usedSeats).toBe(2);
    // Committed follows the SEATS BOUGHT: an unassigned seat is still invoiced.
    expect(row!.committedSpendCents, 'committed spend is not seats × unit cost').toBe(10 * 2400);
    expect(row!.assignedSpendCents, 'assigned spend is not used seats × unit cost').toBe(2 * 2400);
    /*
     * AND THEY MUST DIFFER HERE. Asserted explicitly, because the defect was that one figure served
     * as both — a test checking only "committed is 24000" would pass against a row where assigned
     * was also 24000, which is the shape that made the tile and the table disagree.
     */
    expect(row!.committedSpendCents).toBeGreaterThan(row!.assignedSpendCents!);
  });

  it('carries the status, so a cancelled subscription can be left out of a total', async () => {
    /*
     * The report returns every licence, because the utilisation table wants them all. Nobody is
     * invoiced for a cancelled subscription, though, so the spend total has to be able to exclude
     * them — and it could not: `status` was not on the row at all, and the query has no filter, so
     * cancelled and expired licences were being counted in "Monthly spend".
     */
    const licenseId = await createLicense(5);

    const res = await apiRequest(app, admin, 'GET', '/licenses/utilization');
    const row = unwrap<UtilRow[]>(res.body).find((r) => r.licenseId === licenseId);
    expect(
      row?.status,
      'the row carries no status, so nothing can be excluded from a spend total',
    ).toBe('active');
  });
});

describe('the seat list', () => {
  it('names every holder, including the ones whose seat was revoked', async () => {
    /*
     * TWO HOLDERS, one revoked and one live, because the revoked row is the one that would go
     * unnoticed: a list that names only the CURRENT holders still leaves the true-up — which is
     * precisely the reason revoking is soft — reading uuids.
     */
    const licenseId = await createLicense(2);
    const revokedSeat = await assignSeat(
      licenseId,
      FIXTURE.NO_PERMISSIONS.id,
      'e2e: seat to reclaim',
    );
    await assignSeat(licenseId, FIXTURE.MANAGER.id, 'e2e: seat still in use');

    const dropped = await apiRequest(
      app,
      admin,
      'DELETE',
      `/licenses/assignments/${revokedSeat.id}`,
    );
    /*
     * `< 300` rather than an exact status, and the looseness is deliberate because of a defect worth
     * naming here rather than papering over: this route carries `@ApiNoContentResponse()` and no
     * `@HttpCode(HttpStatus.NO_CONTENT)`, so the published document promises 204 while Nest answers
     * 200. Its sibling `DELETE /licenses/:id` has the same gap; `DELETE /vendors/:id/risks/:riskId`
     * next door is the shape that gets it right. Asserting either number here would encode the bug or
     * break the day somebody fixes it, and this spec is about the NAME on the row.
     */
    expect(dropped.status, JSON.stringify(dropped.body)).toBeLessThan(300);

    const rows = await seats(licenseId, true);
    expect(rows.length, 'the revoked seat was dropped from the history').toBe(2);

    for (const row of rows) {
      expect(
        row.employeeName,
        `seat ${row.id} came back with employee ${row.employeeId} and no name`,
      ).toBeTruthy();
    }

    // Two different people, so two different names — a resolver keyed on the wrong column would
    // hand both rows the same one, which is the failure a single-row test cannot see.
    expect(new Set(rows.map((r) => r.employeeName)).size).toBe(2);
    // And one of the two is the revoked row, which is the half a live-seats-only test would miss.
    expect(rows.filter((r) => r.revokedAt !== null)).toHaveLength(1);
  });

  it('names the holders of the live seats too, which is the default view', async () => {
    /*
     * `includeRevoked` off is what the panel opens with, and it is a different query — so a
     * resolution that only ran on the wider read would leave the ordinary case showing uuids.
     */
    const licenseId = await createLicense(1);
    await assignSeat(licenseId, FIXTURE.MANAGER.id, 'e2e: the default view');

    const rows = await seats(licenseId);
    expect(rows).toHaveLength(1);
    expect(rows[0].employeeName).toBeTruthy();
    expect(rows[0].employeeName).not.toBe(rows[0].employeeId);
  });

  it('costs no name query when a licence has never had a seat assigned', async () => {
    /*
     * `inArray(col, [])` is not valid SQL, so an empty list would be a crash rather than merely a
     * wasted query — and a licence recorded before anybody is given access is the ordinary first
     * state, not an edge case.
     */
    const licenseId = await createLicense(5);
    expect(await seats(licenseId, true)).toEqual([]);
  });

  it('does not resolve the name on the assign write', async () => {
    /*
     * Deliberate, and pinned so it is not "made consistent" later. The caller of this write just
     * supplied `employeeId`, so a name here would be one directory query per mutation spent telling
     * them what they passed in — and the SPA throws this response away and refetches the list. The
     * READ above is where the question is asked.
     */
    const licenseId = await createLicense(1);
    const created = await assignSeat(licenseId, FIXTURE.MANAGER.id, 'e2e: write path');
    expect(created.employeeName).toBeNull();
  });
});
