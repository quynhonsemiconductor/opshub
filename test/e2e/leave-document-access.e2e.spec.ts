/**
 * A LEAVE DOCUMENT IS A MEDICAL CERTIFICATE. Only its owner and an approver may touch it.
 *
 * WHAT THIS EXISTS TO PIN, and why it did not exist before. All three document routes are declared
 * `@AuthorizedInService(...)`, which tells `PolicyGuard` to stand down because the service will make
 * the decision — and the service made none. `presign` and `confirm` took an actor and never consulted
 * it; `getLeaveDocumentUrl` took no actor at all, so no amount of care inside it could have checked
 * who was asking.
 *
 * The effect was that any authenticated employee could read, and replace, a colleague's sick note,
 * using a leave id the list endpoint already hands them. `@AuthorizedInService` names a spec as the
 * promise that the service check exists; the spec it named contains the word "document" zero times.
 * That is the failure this file closes: not the missing check alone, but the missing check behind a
 * citation nobody followed.
 *
 * SO THE ASSERTIONS ARE ABOUT A THIRD PARTY, not about the happy path. A test that only uploads and
 * downloads as the owner passes against a route with no authorization whatsoever — which is exactly
 * what happened here.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d` and `pnpm db:migrate`.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE, apiRequest, createTestApp, login, unwrap, type Session } from './support/harness';

let app: NestFastifyApplication;
/** The owner of the leave request under test. Holds no permissions at all. */
let owner: Session;
/** Holds `workforce.approve` — the approver, who legitimately needs to read the certificate. */
let approver: Session;
/**
 * A THIRD EMPLOYEE. Real permissions, but not `workforce.approve` and not the owner.
 *
 * `AUDITOR` rather than `NO_PERMISSIONS`, because a caller holding nothing proves less: it could be
 * refused for lacking any permission at all rather than for lacking THIS one. And NOT `MANAGER`,
 * which my first draft used — `ROLE.MANAGER` holds `WORKFORCE_APPROVE`, so it is a legitimate
 * approver and its 200 was the correct answer. The fixture, not the fix, was wrong.
 */
let colleague: Session;

beforeAll(async () => {
  app = await createTestApp();
  owner = await login(app, FIXTURE.NO_PERMISSIONS);
  approver = await login(app, FIXTURE.HR);
  colleague = await login(app, FIXTURE.AUDITOR);
});

afterAll(async () => {
  await app?.close();
});

/** A far-future Monday, unique per run: the overlap rule refuses a second request on the same dates. */
/*
 * A YEAR NO OTHER SPEC CAN PICK. The suite shares one database and one set of employee fixtures, and
 * the overlap rule is per employee across every leave type — so two specs that pick a random year
 * from overlapping ranges will eventually choose the same one, and if they also use the same month
 * pattern the windows are identical and the second one to run is refused with LEAVE_OVERLAPPING.
 *
 * That is exactly what happened: this spec and `terminal-transitions` both used the first Monday of
 * months 3, 5, 7, 9, 11 and 12 for the same fixture, from ranges that overlapped by twenty years. It
 * failed roughly one run in twenty, only ever in a full suite.
 *
 * The ranges are therefore DISJOINT and written down here so the next spec picks a free one:
 *   leave-balance            2040–2079
 *   terminal-transitions     2080–2099
 *   leave-document-access    2100–2119
 */
const YEAR = 2100 + (Math.floor(Date.now() / 1000) % 20);

function mondayIn(month: number): string {
  for (let day = 1; day <= 14; day++) {
    const d = new Date(Date.UTC(YEAR, month - 1, day));
    if (d.getUTCDay() === 1) return d.toISOString().slice(0, 10);
  }
  throw new Error(`no Monday in month ${month}`);
}

/** Sick leave filed by the owner — the kind a certificate attaches to. */
async function fileSickLeave(startDate: string): Promise<string> {
  const res = await apiRequest(app, owner, 'POST', '/workforce/leave', {
    leaveType: 'sick',
    startDate,
    endDate: startDate,
    reason: 'e2e: a document will be attached to this',
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return unwrap<{ id: string }>(res.body).id;
}

const PRESIGN_BODY = {
  fileName: 'certificate.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 4096,
};

describe('a colleague', () => {
  it('cannot ask for an upload slot on somebody else’s leave', async () => {
    const leaveId = await fileSickLeave(mondayIn(3));

    const res = await apiRequest(
      app,
      colleague,
      'POST',
      `/workforce/leave-requests/${leaveId}/document/presign`,
      PRESIGN_BODY,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(403);
  });

  it('cannot read somebody else’s certificate', async () => {
    /*
     * The download route is the one that mattered most and was the least defensible: its signature
     * had no caller identity in it, so it could not have checked even in principle.
     */
    const leaveId = await fileSickLeave(mondayIn(5));

    const res = await apiRequest(
      app,
      colleague,
      'GET',
      `/workforce/leave-requests/${leaveId}/document`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(403);
  });

  it('cannot confirm an upload against somebody else’s leave', async () => {
    /*
     * Confirm REPLACES: it soft-deletes whatever was attached before. So this half of the hole was
     * destructive, not merely a disclosure — a colleague could overwrite a certificate.
     *
     * A fabricated file id is fine here: the ownership check has to be refused BEFORE the storage
     * layer is asked anything, so a 403 rather than a 404 is precisely the assertion.
     */
    const leaveId = await fileSickLeave(mondayIn(7));

    const res = await apiRequest(
      app,
      colleague,
      'POST',
      `/workforce/leave-requests/${leaveId}/document/confirm`,
      { fileId: '00000000-0000-7000-8000-0000000000ff' },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(403);
  });
});

describe('the people who may', () => {
  it('lets the OWNER ask for an upload slot', async () => {
    /*
     * The other half of the pin. Without this, tightening the check to "nobody" would also pass —
     * and a certificate the owner cannot attach is a rule that has swallowed the feature.
     */
    const leaveId = await fileSickLeave(mondayIn(9));

    const res = await apiRequest(
      app,
      owner,
      'POST',
      `/workforce/leave-requests/${leaveId}/document/presign`,
      PRESIGN_BODY,
    );
    // 200: a presign mints no resource, and the route says so with `@HttpCode(HttpStatus.OK)`.
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('lets an APPROVER read the document route', async () => {
    /*
     * An approver deciding sick leave has to be able to open the certificate; that is why the rule is
     * owner-or-approver and not owner-only. Asserted as "not refused" rather than on the body, because
     * nothing has been uploaded here — `documentUrl` is legitimately null. What must not happen is 403.
     */
    const leaveId = await fileSickLeave(mondayIn(11));

    const res = await apiRequest(
      app,
      approver,
      'GET',
      `/workforce/leave-requests/${leaveId}/document`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(unwrap<{ documentUrl: string | null }>(res.body).documentUrl).toBeNull();
  });

  it('lets the owner read their own', async () => {
    const leaveId = await fileSickLeave(mondayIn(12));

    const res = await apiRequest(
      app,
      owner,
      'GET',
      `/workforce/leave-requests/${leaveId}/document`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});
