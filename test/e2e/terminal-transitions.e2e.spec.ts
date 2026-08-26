/**
 * A TERMINAL STATE MUST BE TERMINAL.
 *
 * WHY THIS FILE EXISTS. Every module here ends its records the same way — cancel, retire, revoke —
 * and each of those routes was reachable with no test behind it. I found them by listing the
 * transition endpoints in the API and asking which ones any suite calls: of twenty-three, these four
 * were called by nothing.
 *
 *   POST /v1/requests/:id/cancel
 *   POST /v1/workforce/leave/:id/cancel
 *   POST /v1/assets/:id/retire
 *   POST /v1/access-requests/grants/:grantId/revoke
 *
 * All four turned out to be GUARDED — I read each service before writing a line here, and none of
 * them needed fixing. That is the reason to pin them: an untested guard is one refactor away from
 * being an untested absence, and the failure it lets through is silent. Approving a cancelled
 * request, retiring a laptop that is still in someone's hands, and revoking an already-revoked grant
 * all return a plausible 200 and leave the record wrong.
 *
 * WHAT EACH CASE ASSERTS, beyond a status code. A transition test that only checks the second call
 * is refused proves the guard fires but not that the FIRST call did anything. So each case pairs the
 * refusal with the consequence: the days come back, the asset is out of service, the grant is gone
 * from the holder's active list, the request can no longer be approved by anyone.
 *
 * DATES ARE UNIQUE PER RUN. The database is shared between suites and never reset, and the overlap
 * rule refuses a second request across the same window — fixed dates make a spec that passes once.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d` and `pnpm db:migrate`.
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

let app: NestFastifyApplication;
/** Holds nothing. Files their own leave and their own access request. */
let employee: Session;
/** Holds `workforce.approve`, `asset.manage`, and the security half of the access chain. */
let admin: Session;
/** Holds `access_request.approve` (step 1) and NOT `access_request.security_approve` (step 2). */
let stepOne: Session;

beforeAll(async () => {
  app = await createTestApp();
  employee = await login(app, FIXTURE.NO_PERMISSIONS);
  admin = await login(app, FIXTURE.ADMIN);
  stepOne = await login(app, FIXTURE.MANAGER);
});

afterAll(async () => {
  await app?.close();
});

/**
 * A far-future year, distinct per run, so no two runs share a leave window.
 *
 * A year rather than a suffix on the dates because the overlap rule is per employee across all
 * time: two runs in the same year would collide on the second one and the failure would look like
 * a broken guard rather than a fixture clash.
 */
// 2080–2099, disjoint from every other spec's range — see the note in `leave-document-access`. This
// spec and that one both walk the first Monday of months 3, 5, 7, 9, 11 and 12 for the same employee
// fixture, so overlapping ranges meant identical windows whenever both picked the same year.
const YEAR = 2080 + (Math.floor(Date.now() / 1000) % 20);

/** The first Monday of `month` in YEAR, as `YYYY-MM-DD`. Mondays because a weekend window costs
 * zero working days and is refused outright with `LEAVE_NO_WORKING_DAYS`. */
function mondayIn(month: number): string {
  for (let day = 1; day <= 14; day++) {
    const d = new Date(Date.UTC(YEAR, month - 1, day));
    if (d.getUTCDay() === 1) return d.toISOString().slice(0, 10);
  }
  throw new Error(`no Monday in month ${month}`);
}

/** `date` shifted by whole days, as `YYYY-MM-DD`. */
function plusDays(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** Just enough of a record to assert a transition against. */
interface Record_ {
  id: string;
  status: string;
}

/** File leave as the unprivileged fixture over a window nobody else has used. */
async function fileLeave(startDate: string): Promise<string> {
  const res = await apiRequest(app, employee, 'POST', '/workforce/leave', {
    leaveType: 'annual',
    startDate,
    endDate: plusDays(startDate, 1),
    reason: 'e2e: terminal transitions',
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return unwrap<Record_>(res.body).id;
}

describe('leave cancellation', () => {
  it('gives the window back, so the same dates can be requested again', async () => {
    /*
     * THE CONSEQUENCE, not the status code. Cancelling writes one column; what an employee cares
     * about is that the days stop being spent. Both the balance and the overlap rule read
     * `status in ('pending','approved')`, so cancelling frees the window — and re-filing over the
     * identical dates is the only way to observe from outside that it did.
     *
     * The collision is asserted FIRST. Without that half, this would pass against an overlap rule
     * that never worked, and the re-file would prove nothing.
     */
    const start = mondayIn(3);
    const first = await fileLeave(start);

    const blocked = await apiRequest(app, employee, 'POST', '/workforce/leave', {
      leaveType: 'annual',
      startDate: start,
      endDate: plusDays(start, 1),
      reason: 'e2e: must collide while the first is live',
    });
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(409);
    expect(errorCode(blocked.body)).toBe('LEAVE_OVERLAPPING');

    const cancelled = await apiRequest(app, employee, 'POST', `/workforce/leave/${first}/cancel`);
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(201);
    expect(unwrap<Record_>(cancelled.body).status).toBe('cancelled');

    // The window is free again.
    const refiled = await fileLeave(start);
    expect(refiled).not.toBe(first);
  });

  it('refuses to cancel an already cancelled request', async () => {
    const id = await fileLeave(mondayIn(5));

    const first = await apiRequest(app, employee, 'POST', `/workforce/leave/${id}/cancel`);
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    const second = await apiRequest(app, employee, 'POST', `/workforce/leave/${id}/cancel`);
    expect(second.status, JSON.stringify(second.body)).toBe(412);
    expect(errorCode(second.body)).toBe('LEAVE_REQUEST_NOT_PENDING');
  });

  it('cancels an APPROVED request too, not only a pending one', async () => {
    /*
     * Approved leave is the case that matters. Plans change after a manager has said yes, and by
     * then the days are already counted against the balance — a guard admitting only `pending`
     * would strand them. `cancelLeave` admits both, and this is the half a single-path test misses.
     */
    const id = await fileLeave(mondayIn(7));

    const approved = await apiRequest(app, admin, 'POST', `/workforce/leave/${id}/review`, {
      approve: true,
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);
    expect(unwrap<Record_>(approved.body).status).toBe('approved');

    const cancelled = await apiRequest(app, employee, 'POST', `/workforce/leave/${id}/cancel`);
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(201);
    expect(unwrap<Record_>(cancelled.body).status).toBe('cancelled');
  });
});

describe('request cancellation', () => {
  /** The request-engine row behind a freshly filed leave request. */
  async function pendingRequestId(leaveStart: string): Promise<string> {
    await fileLeave(leaveStart);
    const res = await apiRequest(
      app,
      admin,
      'GET',
      `/requests?requesterId=${FIXTURE.NO_PERMISSIONS.id}&limit=50`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const pending = unwrap<Record_[]>(res.body).find((r) => r.status === 'pending');
    expect(pending, 'no pending request row for the leave just filed').toBeDefined();
    return pending!.id;
  }

  it('cannot be approved after it is cancelled, by anyone', async () => {
    /*
     * THE INVARIANT WORTH THE MOST HERE. Cancel and approve are separate handlers with separate
     * guards, and the dangerous failure is not a cancel that fails — it is an approve that succeeds
     * afterwards, granting what the request asked for to somebody who withdrew it.
     *
     * Asserted with the ADMIN token on purpose, so the refusal is about the request's STATE and not
     * about the caller's permissions.
     */
    const id = await pendingRequestId(mondayIn(9));

    const cancelled = await apiRequest(app, employee, 'POST', `/requests/${id}/cancel`, {});
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(unwrap<Record_>(cancelled.body).status).toBe('cancelled');

    const approved = await apiRequest(app, admin, 'POST', `/requests/${id}/approve`, {});
    expect(approved.status, JSON.stringify(approved.body)).toBe(412);
    expect(errorCode(approved.body)).toBe('REQUEST_NOT_PENDING');

    const rejected = await apiRequest(app, admin, 'POST', `/requests/${id}/reject`, {
      note: 'e2e: must not be possible either',
    });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(412);
    expect(errorCode(rejected.body)).toBe('REQUEST_NOT_PENDING');
  });

  it('refuses a second cancel', async () => {
    const id = await pendingRequestId(mondayIn(11));

    const first = await apiRequest(app, employee, 'POST', `/requests/${id}/cancel`, {});
    expect(first.status, JSON.stringify(first.body)).toBe(200);

    const second = await apiRequest(app, employee, 'POST', `/requests/${id}/cancel`, {});
    expect(second.status, JSON.stringify(second.body)).toBe(412);
    expect(errorCode(second.body)).toBe('REQUEST_NOT_CANCELLABLE');
  });

  it('is refused for somebody else’s request', async () => {
    /*
     * `cancel` is `@AuthorizedInService`, which means the route guard admits every authenticated
     * caller and the service decides. So the ownership check has to be exercised over HTTP: a unit
     * test on the engine cannot show that the controller actually consults it.
     *
     * MANAGER is the right caller — real permissions, but not `rbac.manage` — so the refusal is
     * about ownership rather than about holding nothing at all.
     */
    const id = await pendingRequestId(mondayIn(12));

    const res = await apiRequest(app, stepOne, 'POST', `/requests/${id}/cancel`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(403);
  });
});

describe('asset retirement', () => {
  async function createAsset(): Promise<string> {
    const res = await apiRequest(app, admin, 'POST', '/assets', {
      assetTag: `E2E-TERM-${Date.now().toString(36).toUpperCase()}`,
      type: 'laptop',
      manufacturer: 'Acme',
      model: 'Book 13',
      status: 'in_stock',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return unwrap<Record_>(res.body).id;
  }

  it('refuses to retire an asset that is still assigned', async () => {
    /*
     * The failure this prevents is a physical one. Retiring is how a laptop leaves the register, so
     * doing it while somebody still holds the machine writes off hardware that is in a drawer at
     * home — and the register can no longer say who has it.
     */
    const id = await createAsset();

    const assigned = await apiRequest(app, admin, 'POST', `/assets/${id}/assign`, {
      employeeId: FIXTURE.NO_PERMISSIONS.id,
      notes: 'e2e: terminal transitions',
    });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);

    const refused = await apiRequest(app, admin, 'POST', `/assets/${id}/retire`);
    expect(refused.status, JSON.stringify(refused.body)).toBe(412);
    expect(errorCode(refused.body)).toBe('ASSET_ALREADY_ASSIGNED');

    // And it goes through once the machine is actually back.
    const unassigned = await apiRequest(app, admin, 'POST', `/assets/${id}/unassign`);
    expect(unassigned.status, JSON.stringify(unassigned.body)).toBe(200);

    const retired = await apiRequest(app, admin, 'POST', `/assets/${id}/retire`);
    expect(retired.status, JSON.stringify(retired.body)).toBe(200);
    expect(unwrap<Record_>(retired.body).status).toBe('retired');
  });

  it('cannot be assigned again once retired', async () => {
    /*
     * The consequence half. A retired asset that is still assignable was never retired, and the
     * second call is the only thing separating a real state change from a status string.
     */
    const id = await createAsset();

    const retired = await apiRequest(app, admin, 'POST', `/assets/${id}/retire`);
    expect(retired.status, JSON.stringify(retired.body)).toBe(200);

    const again = await apiRequest(app, admin, 'POST', `/assets/${id}/retire`);
    expect(again.status, JSON.stringify(again.body)).toBe(412);
    expect(errorCode(again.body)).toBe('ASSET_RETIRED');

    const assigned = await apiRequest(app, admin, 'POST', `/assets/${id}/assign`, {
      employeeId: FIXTURE.NO_PERMISSIONS.id,
    });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(412);
  });
});

describe('access grant revocation', () => {
  it('takes the grant out of the holder’s active list, and refuses a second revoke', async () => {
    /*
     * Revocation is the security-relevant one: the grant row is what an access review reads to
     * answer "who can reach this today". A revoke that reports success without clearing it leaves a
     * standing entitlement that every subsequent review keeps re-approving.
     *
     * The grant exists only after BOTH approval steps — step 1 issues nothing — so the chain is
     * walked in full rather than short-cut through a seeded row.
     */
    const submitted = await apiRequest(app, employee, 'POST', '/access-requests', {
      accessType: 'app_admin',
      target: 'jira',
      justification: 'e2e: revoke must clear the grant',
      durationHours: 8,
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
    const requestId = unwrap<Record_>(submitted.body).id;

    const step1 = await apiRequest(
      app,
      stepOne,
      'POST',
      `/access-requests/${requestId}/approve`,
      {},
    );
    expect(step1.status, JSON.stringify(step1.body)).toBe(201);

    const step2 = await apiRequest(app, admin, 'POST', `/access-requests/${requestId}/approve`, {});
    expect(step2.status, JSON.stringify(step2.body)).toBe(201);

    const active = await apiRequest(app, employee, 'GET', '/access-requests/grants/me/active');
    expect(active.status, JSON.stringify(active.body)).toBe(200);
    const grants = unwrap<{ id: string; requestId?: string }[]>(active.body);
    const grant = grants.find((g) => g.requestId === requestId);
    expect(grant, 'both steps approved and no grant was issued').toBeDefined();

    const revoked = await apiRequest(
      app,
      admin,
      'POST',
      `/access-requests/grants/${grant!.id}/revoke`,
    );
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);

    // Gone from the holder's own view — the list an access review reads.
    const after = await apiRequest(app, employee, 'GET', '/access-requests/grants/me/active');
    expect(unwrap<{ id: string }[]>(after.body).some((g) => g.id === grant!.id)).toBe(false);

    const again = await apiRequest(
      app,
      admin,
      'POST',
      `/access-requests/grants/${grant!.id}/revoke`,
    );
    expect(again.status, JSON.stringify(again.body)).toBe(412);
    expect(errorCode(again.body)).toBe('ACCESS_GRANT_NOT_ACTIVE');
  });
});
