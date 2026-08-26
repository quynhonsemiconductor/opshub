/**
 * A caller may see requests they are a party to, and no others.
 *
 * WHAT WAS WRONG
 * --------------
 * `RequestEngine.list` and the access-request repository built their WHERE clause from OPTIONAL
 * filters only:
 *
 *     const where = conditions.length ? and(...conditions) : undefined;
 *
 * so an unfiltered call returned EVERY row — every employee's leave, onboarding, catalog and
 * privileged-access request, with justifications and approval chains — to any authenticated
 * caller. `actorId` was used for nothing but the `myQueue` shortcut. `getById`, `listComments`
 * and `addComment` performed no ownership or participant check at all, so `addComment` was a
 * WRITE onto a record the caller could not otherwise read.
 *
 * WHY NOTHING CAUGHT IT
 * ---------------------
 * The unit specs call the engine with filters, and the route ratchet counts decorators — it
 * cannot see authorization that lives (or fails to live) inside a service. Nothing ever issued
 * an unfiltered list as a principal holding no permissions, which is precisely the shape a
 * self-service SPA sends.
 *
 * This spec is named by the `@AuthorizedInService(..., pinnedBy)` declarations on all six
 * routes, and asserts BOTH directions: the employee is narrowed, the permission holder is not.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d` and `pnpm db:seed`.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RequestEngine } from '@platform';
import { REQUEST_TYPE } from '@shared-kernel';
import { FIXTURE, apiRequest, bearer, createTestApp, login, type Session } from './support/harness';

let app: NestFastifyApplication;
/** `employee` holds NO permission codes — the tier every narrowing rule must constrain. */
let employee: Session;
/** `hr` holds `request.read`, so it is the unconstrained side of every assertion. */
let hr: Session;
/**
 * Holds `*`, so it can decide any request regardless of type.
 *
 * Logged in once here rather than inside the tests that need it: `AUTH_LOGIN` is rate limited, and a
 * suite that logs the same identity in from three places starts failing on a 429 that has nothing to do
 * with what it is testing.
 */
let admin: Session;
/** `request.read` and no approval code anywhere — the tier the inbox used to offer Approve to. */
let auditor: Session;
/** A request owned by the employee, so there is something they legitimately may see. */
let ownRequestId: string;
/** A request owned by HR — the thing the employee must NOT be able to reach. */
let foreignRequestId: string;
/**
 * A pending request that HAS an assignee, which nothing else in the suite produces.
 *
 * No HTTP route sets one: every caller of `engine.submit` omits `assigneeId`, and the only other writer
 * is the multi-step advance, which needs an `ApprovalStepDef.resolverFn` and no type defines one. So a
 * request assigned to a named person can only be made through the engine, and without one the assertion
 * that the assignee is NAMED would pass against a null.
 */
let assignedRequestId: string;
/** A request that has been decided, so there is an approval row with a real approver on it. */
let decidedRequestId: string;

interface RequestRow {
  id: string;
  requesterId: string;
  /** Resolved server-side. Null when the requester's employee row is gone. */
  requesterName: string | null;
  assigneeId: string | null;
  /** Resolved server-side. Null when the request is unassigned, or the assignee's row is gone. */
  assigneeName: string | null;
  approvals?: { step: number; approverId: string; approverName: string | null }[];
  status?: string;
  /** Answered by the engine that enforces it, so the inbox stops offering refusals. */
  viewerMayDecide?: boolean;
  viewerCannotDecideReason?: 'own_request' | 'missing_permission' | 'not_open' | null;
}

async function getRequest(session: Session, id: string): Promise<RequestRow> {
  const res = await app.inject({
    method: 'GET',
    url: `/v1/requests/${id}`,
    headers: bearer(session),
  });
  expect(res.statusCode, res.body).toBe(200);
  /*
   * NO `.data` HERE. The list is paged and therefore enveloped; a single request is returned bare, so
   * reading `.data` off it yields `undefined` and every field assertion then reads a property of
   * undefined. The shared `unwrap` in support/harness exists for exactly this and falls back to the
   * body — this file predates it and hand-rolls its own accessors, so the fallback is spelled out.
   */
  const body = JSON.parse(res.body) as RequestRow & { data?: RequestRow };
  return body.data ?? body;
}

async function listRequests(session: Session, query = ''): Promise<RequestRow[]> {
  const res = await app.inject({
    method: 'GET',
    url: `/v1/requests${query}`,
    headers: bearer(session),
  });
  expect(res.statusCode, res.body).toBe(200);
  return (JSON.parse(res.body) as { data: RequestRow[] }).data;
}

beforeAll(async () => {
  app = await createTestApp();
  employee = await login(app, FIXTURE.NO_PERMISSIONS);
  hr = await login(app, FIXTURE.HR);
  auditor = await login(app, FIXTURE.AUDITOR);
  admin = await login(app, FIXTURE.ADMIN);

  // File a leave request as the employee: it enters the generic engine, so it is a request
  // they ARE a party to, alongside whatever the seed created for everyone else.
  const res = await app.inject({
    method: 'POST',
    url: '/v1/workforce/leave',
    headers: bearer(employee),
    payload: {
      leaveType: 'annual',
      startDate: '2027-03-01',
      endDate: '2027-03-02',
      reason: 'request visibility fixture',
    },
  });
  expect(res.statusCode, res.body).toBe(201);

  const own = await listRequests(employee);
  expect(own.length, 'the employee should see the request they just filed').toBeGreaterThan(0);
  ownRequestId = own[0].id;

  // A request the employee is NOT a party to. Created rather than looked up: the seed produces
  // none, so the first version of this spec found nothing foreign to test against and its three
  // refusal cases failed on the fixture instead of on the rule.
  const hrRes = await app.inject({
    method: 'POST',
    url: '/v1/workforce/leave',
    headers: bearer(hr),
    payload: {
      leaveType: 'annual',
      startDate: '2027-04-01',
      endDate: '2027-04-02',
      reason: 'foreign request fixture',
    },
  });
  expect(hrRes.statusCode, hrRes.body).toBe(201);

  const hrRows = await listRequests(hr);
  const foreign = hrRows.find((r) => r.requesterId === FIXTURE.HR.id);
  expect(foreign, 'HR should see the request HR just filed').toBeDefined();
  foreignRequestId = foreign!.id;

  // And an ACCESS request owned by HR. Needed for the same reason: with none in the database,
  // "the employee sees no foreign access requests" is true whether or not the narrowing works —
  // proven by mutation testing, where removing the narrowing left that assertion passing.
  const grantRes = await app.inject({
    method: 'POST',
    url: '/v1/access-requests',
    headers: bearer(hr),
    payload: {
      accessType: 'pim_role',
      target: 'visibility-fixture',
      justification: 'foreign access-request fixture',
      durationHours: 4,
    },
  });
  expect(grantRes.statusCode, grantRes.body).toBe(201);

  /*
   * The two rows the naming assertions need, both raised through the engine rather than through a domain
   * route. `catalog_request` is the type used because it is the only one whose lifecycle hooks are inert —
   * no `onSubmit` validation and an `onApprove` that deliberately does nothing, fulfilment being manual —
   * so submitting and approving one exercises the request engine and nothing else. Driving a leave request
   * here instead would have made these cases fail on a working-day rule or an overlapping window, which is
   * how the offboarding case in this file already went wrong once.
   */
  const engine = app.get(RequestEngine);
  const requester = { sub: FIXTURE.NO_PERMISSIONS.id, email: FIXTURE.NO_PERMISSIONS.email };

  const assigned = await engine.submit(
    REQUEST_TYPE.CATALOG_REQUEST,
    {
      catalogItemId: 'visibility-fixture',
      catalogItemName: 'Standard laptop',
      reason: 'assignee name',
    },
    requester,
    // The whole point of this fixture: a request pointed at a NAMED person, so "who is this waiting on"
    // has an answer that can be got wrong.
    { assigneeId: FIXTURE.HR.id },
  );
  assignedRequestId = assigned.id;

  const toDecide = await engine.submit(
    REQUEST_TYPE.CATALOG_REQUEST,
    {
      catalogItemId: 'visibility-fixture',
      catalogItemName: 'Standard laptop',
      reason: 'approver name',
    },
    requester,
  );
  // Decided by ADMIN and not by the requester: `allowSelfApproval` is false on this type, and an approval
  // row whose approver is also the requester could not tell the two resolved names apart.
  const decided = await app.inject({
    method: 'POST',
    url: `/v1/requests/${toDecide.id}/approve`,
    headers: bearer(admin),
    payload: {},
  });
  expect(decided.statusCode, decided.body).toBe(200);
  decidedRequestId = toDecide.id;
});

afterAll(async () => {
  await app?.close();
});

describe('request visibility', () => {
  it('narrows an unfiltered list to the caller', async () => {
    const rows = await listRequests(employee);

    const foreign = rows.filter((r) => r.requesterId !== FIXTURE.NO_PERMISSIONS.id);
    expect(
      foreign,
      'An unfiltered GET /requests returned requests belonging to other people. This is the ' +
        'leak: WHERE was built from optional filters, so no filters meant no WHERE.',
    ).toEqual([]);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('names the requester, so an approval queue can be decided from', async () => {
    /*
     * WHAT THE INBOX SHOWED BEFORE: the request type and `id.slice(0, 8)`. No requester — so the screen
     * whose buttons are Approve and Reject did not say who was asking. The id made it worse rather than
     * better: these are uuid v7, TIME-PREFIXED, so requests filed in the same window share their leading
     * characters and several rows rendered the same eight.
     *
     * Asserted against the API rather than only in the browser, because it is the API that has to supply
     * it: the SPA cannot resolve fifty uuids without fifty requests.
     */
    const rows = await listRequests(employee);
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      expect(
        row.requesterName,
        `request ${row.id} came back with no requester name, so the inbox row is undecidable`,
      ).toBeTruthy();
    }
  });

  it('still names the requester after they are offboarded', async () => {
    /*
     * I WROTE THIS TEST BACKWARDS FIRST, and the failure was the useful part: I asserted the name comes
     * back null once the requester leaves. It does not, because offboarding sets `status` and does not
     * delete the row — there is no DELETE route for an employee at all, only `/avatar`.
     *
     * Which makes the real property the opposite one, and a better one: a leaver's request still says who
     * filed it. An offboarded employee's access request is exactly what an access review comes back to,
     * and a queue that forgot the name would be answering "somebody asked for this" — the same
     * uninterpretable row the uuid gave, arriving by a different route.
     *
     * The resolution stays a LEFT lookup and `requesterName` stays nullable anyway: it costs nothing, and
     * an inner join would make the REQUEST disappear with the employee rather than just the name.
     */
    const email = `inbox.leaver.${Date.now().toString(36)}@opshub.local`;

    const created = await app.inject({
      method: 'POST',
      url: '/v1/employees',
      headers: bearer(admin),
      payload: { email, displayName: 'Departing Requester', roles: ['employee'] },
    });
    expect(created.statusCode, created.body).toBe(201);
    const body = JSON.parse(created.body) as { data?: { id: string }; id?: string };
    const leaverId = body.data?.id ?? body.id!;

    const leaver = await login(app, { email });
    const filed = await app.inject({
      method: 'POST',
      url: '/v1/workforce/leave',
      headers: bearer(leaver),
      payload: {
        // A Monday and a Tuesday: a weekend window is refused with LEAVE_NO_WORKING_DAYS, which is
        // what the first version of this test picked.
        leaveType: 'annual',
        startDate: '2027-05-03',
        endDate: '2027-05-04',
        reason: 'filed by somebody about to leave',
      },
    });
    expect(filed.statusCode, filed.body).toBe(201);

    const offboarded = await app.inject({
      method: 'PATCH',
      url: `/v1/employees/${leaverId}/status`,
      headers: bearer(admin),
      payload: { status: 'offboarded' },
    });
    expect(offboarded.statusCode, offboarded.body).toBe(200);

    const rows = await listRequests(hr, `?requesterId=${leaverId}`);
    expect(rows.length, 'the request vanished along with its requester').toBeGreaterThan(0);
    expect(
      rows[0].requesterName,
      'an offboarded requester lost their name, so an access review reads "somebody asked for this"',
    ).toBe('Departing Requester');
  });

  it('names the assignee a pending request is waiting on', async () => {
    /*
     * THE OTHER PERSON ON THE ROW, and the one an approver looks for first. The drawer's Assignee field
     * rendered `assigneeId` in a monospace font — a bare uuid — so the question it exists to answer,
     * "whose desk is this sitting on", got 36 characters that do not answer it. An approver checking
     * whether a request was theirs could not tell without comparing uuids by eye.
     *
     * Asserted on the LIST row and on the by-id read both, because they are two separate resolutions in
     * the engine — `list` batches a page, `loadUnchecked` resolves one request — and the SPA uses each:
     * the drawer is filled from the list row it was opened from, while the by-id route is what any other
     * caller of a single request gets. Fixing one and not the other would leave the uuid on screen for
     * half the callers and pass a test that only looked at the other half.
     *
     * Null is NOT the expectation here even though the field is nullable. Nullable covers the unassigned
     * request, which is a normal pending state, and this fixture is deliberately not that.
     */
    const rows = await listRequests(hr, `?requesterId=${FIXTURE.NO_PERMISSIONS.id}&limit=50`);
    const row = rows.find((r) => r.id === assignedRequestId);
    expect(row, 'the assigned fixture request is missing from the list').toBeDefined();

    expect(row!.assigneeId, 'the fixture lost its assignee, so this proves nothing').toBe(
      FIXTURE.HR.id,
    );
    expect(
      row!.assigneeName,
      'the assignee came back as a uuid only, so the inbox cannot say who the request is waiting on',
    ).toBe('HR Manager');

    const single = await getRequest(hr, assignedRequestId);
    expect(
      single.assigneeName,
      'the by-id read resolves the assignee separately from the list, and did not resolve it',
    ).toBe('HR Manager');
  });

  it('names the approver on each decided step', async () => {
    /*
     * THE APPROVAL CHAIN IS THE AUDIT TRAIL OF THE DECISION. It is the record consulted when somebody asks
     * who granted an access, or approved an absence, or accepted a risk — and every row of it showed
     * `approverId`, so the trail said that somebody had decided without saying who. An audit trail that
     * cannot name the decider does not discharge the review it is kept for.
     *
     * The approver here is ADMIN and the requester is the unprivileged employee, so a resolution that
     * accidentally reported the requester's name for both would fail rather than look right.
     *
     * Resolved in the same batched lookup as the requester and the assignee, which is why this asserts
     * from the list: a page of decided requests must not turn into one query per approval row. The
     * approvals were already being fetched in one query for the whole page, so their approver ids were
     * in hand and cost nothing to add to the lookup that was happening anyway.
     */
    const rows = await listRequests(hr, `?requesterId=${FIXTURE.NO_PERMISSIONS.id}&limit=50`);
    const row = rows.find((r) => r.id === decidedRequestId);
    expect(row, 'the decided fixture request is missing from the list').toBeDefined();

    const approvals = row!.approvals ?? [];
    expect(approvals.length, 'the approval left no row, so there is no trail to name').toBe(1);
    expect(approvals[0].approverId).toBe(FIXTURE.ADMIN.id);
    expect(
      approvals[0].approverName,
      'the approval history named nobody, so it records that a decision happened and not who made it',
    ).toBe('Admin User');

    const single = await getRequest(hr, decidedRequestId);
    expect(
      single.approvals?.[0]?.approverName,
      'the by-id read resolves the chain separately from the list, and did not resolve it',
    ).toBe('Admin User');
  });

  it('tells a read-only role it may not decide, instead of offering it', async () => {
    /*
     * THE 403 WALL. The inbox gated Approve and Reject on the request's STATUS alone, so any holder of
     * `request.read` saw them on every pending request in the tenant. `ROLE.AUDITOR` is exactly that
     * tier — `request.read` and no approval code anywhere — so every click it made was a permanent
     * refusal, reported as "please try again".
     *
     * The answer now comes from the engine that enforces it, because the client cannot work it out:
     * the required permission depends on the type's step, separation of duties is judged against the
     * DELEGATOR when one is active, and either identity's permission satisfies it.
     */
    const rows = await listRequests(auditor, '?limit=50');
    expect(rows.length, 'nothing visible to the auditor, so this proves nothing').toBeGreaterThan(
      0,
    );

    const open = rows.filter((r) => r.status === 'pending' || r.status === 'in_review');
    expect(open.length, 'no open request to ask about').toBeGreaterThan(0);
    for (const row of open) {
      expect(
        row.viewerMayDecide,
        `request ${row.id} is offered to a role that holds no approval permission`,
      ).toBe(false);
      // And the reason is the actionable one: ask for access, not ask a colleague.
      expect(row.viewerCannotDecideReason).toBe('missing_permission');
    }
  });

  it('will not let anyone decide their own request, however much permission they hold', async () => {
    /*
     * Separation of duties, from the reader's side. ADMIN holds the wildcard, so this is not about
     * permission at all — which is the point: the inbox offered an approver their own request and the
     * engine refused it with a distinct code, and the screen collapsed that into "please try again".
     */
    const own = await apiRequest(app, admin, 'POST', '/workforce/leave', {
      leaveType: 'annual',
      startDate: '2029-03-05',
      endDate: '2029-03-06',
      reason: 'e2e: filed by somebody who could otherwise approve it',
    });
    expect(own.status, JSON.stringify(own.body)).toBe(201);

    const rows = await listRequests(admin, `?requesterId=${FIXTURE.ADMIN.id}&limit=50`);
    const mine = rows.find((r) => r.status === 'pending');
    expect(mine, 'the request just filed is not in the list').toBeDefined();

    expect(mine!.viewerMayDecide, 'the wildcard holder is offered their own request').toBe(false);
    expect(mine!.viewerCannotDecideReason).toBe('own_request');
  });

  it('does offer it to somebody who may actually decide', async () => {
    /*
     * The other half, and without it the two cases above would pass against a field hard-wired to
     * false — which would replace a wall of 403s with an inbox nobody can act on at all.
     */
    const filed = await apiRequest(app, employee, 'POST', '/workforce/leave', {
      leaveType: 'annual',
      startDate: '2029-04-02',
      endDate: '2029-04-03',
      reason: 'e2e: somebody else decides this one',
    });
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);

    // HR holds `workforce.approve` and `workforce.leave.review`, and did not file it.
    const rows = await listRequests(hr, `?requesterId=${FIXTURE.NO_PERMISSIONS.id}&limit=50`);
    const decidable = rows.find((r) => r.status === 'pending');
    expect(decidable, 'no pending request for the approver to see').toBeDefined();
    expect(
      decidable!.viewerMayDecide,
      'an approver who holds the step permission is not offered the decision',
    ).toBe(true);
    expect(decidable!.viewerCannotDecideReason).toBeNull();
  });

  it('does not let a requesterId filter widen the narrowing', async () => {
    // The narrowing predicate is ANDed with the caller's filters rather than overwriting them,
    // so asking for someone else's requests cannot reach them.
    const rows = await listRequests(employee, `?requesterId=${FIXTURE.HR.id}`);

    expect(
      rows,
      'Filtering by another user id escaped the narrowing — the predicate is being replaced ' +
        'rather than ANDed.',
    ).toEqual([]);
  });

  it("lets a holder of request.read see other people's requests", async () => {
    const rows = await listRequests(hr);

    // The other half of the rule: narrowing must not apply to the staff tiers, or the approval
    // queues stop working. Asserted by finding the employee's request from HR's session.
    expect(
      rows.some((r) => r.requesterId === FIXTURE.NO_PERMISSIONS.id),
      'HR holds request.read but cannot see an employee request — the narrowing is applying ' +
        'to a permission holder.',
    ).toBe(true);
  });

  it('refuses a by-id read of a request the caller is not party to', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/requests/${foreignRequestId}`,
      headers: bearer(employee),
    });

    expect(res.statusCode, res.body).toBe(403);
  });

  it("allows a by-id read of the caller's own request", async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/requests/${ownRequestId}`,
      headers: bearer(employee),
    });

    expect(res.statusCode, res.body).toBe(200);
  });

  it('refuses reading comments on a request the caller is not party to', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/requests/${foreignRequestId}/comments`,
      headers: bearer(employee),
    });

    expect(res.statusCode, res.body).toBe(403);
  });

  it('refuses COMMENTING on a request the caller is not party to', async () => {
    // The write case, and the worst of the six: posting onto a record you cannot read.
    const res = await app.inject({
      method: 'POST',
      url: `/v1/requests/${foreignRequestId}/comments`,
      headers: bearer(employee),
      payload: { body: 'should not be accepted' },
    });

    expect(res.statusCode, res.body).toBe(403);
  });

  it('lets the caller comment on their own request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/requests/${ownRequestId}/comments`,
      headers: bearer(employee),
      payload: { body: 'my own request' },
    });

    expect(res.statusCode, res.body).toBe(201);
  });

  it('narrows the access-request list to the caller', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/access-requests',
      headers: bearer(employee),
    });
    expect(res.statusCode, res.body).toBe(200);

    const rows = (JSON.parse(res.body) as { data: { requesterId: string }[] }).data;
    expect(
      rows.filter((r) => r.requesterId !== FIXTURE.NO_PERMISSIONS.id),
      'the access-request list leaked other requesters',
    ).toEqual([]);

    // HR's own list must contain the request HR filed, or the assertion above proves nothing:
    // an empty table satisfies "no foreign rows" with the narrowing removed.
    const hrRes = await app.inject({
      method: 'GET',
      url: '/v1/access-requests',
      headers: bearer(hr),
    });
    expect(hrRes.statusCode, hrRes.body).toBe(200);
    const hrOwned = (JSON.parse(hrRes.body) as { data: { requesterId: string }[] }).data;
    expect(
      hrOwned.some((r) => r.requesterId === FIXTURE.HR.id),
      'fixture is not exercising the narrowing — no foreign access request exists to hide',
    ).toBe(true);
  });
});
