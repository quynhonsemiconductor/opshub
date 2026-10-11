/**
 * Controlled documents, end to end: draft → approve → publish → acknowledge → supersede.
 *
 * WHAT THIS PINS, AND WHY EACH NEEDS A FLOW
 * -----------------------------------------
 *   - an AUTHOR cannot approve their own policy (separation of duties, enforced by RequestEngine
 *     rather than by this module — so this proves the wiring, not a local `if`)
 *   - approval does NOT publish: a policy is routinely approved before it takes effect, and
 *     collapsing the two makes "which revision was in force on this date" unanswerable
 *   - publishing SUPERSEDES the previous version, atomically, and at most one version is ever in
 *     force
 *   - acknowledgement is per VERSION: publishing v2 makes it outstanding again for everyone who
 *     had acknowledged v1. This is the ISO requirement and the single most common way the feature
 *     is built wrong, so it gets the longest test here
 *   - acknowledging twice is one acknowledgement
 *
 * Named by `@AuthorizedInService(..., 'controlled-documents.e2e.spec.ts')` on the submit route,
 * which is a promise that this file checks the approval path in both directions.
 *
 * A UNIQUE DOCUMENT CODE PER RUN. `uq_document_code` is unique and the database is shared with the
 * other suites without a reset between them, so a fixed code makes a spec that passes once — the
 * same mistake that cost a debugging round in the leave specs.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d` and `pnpm db:migrate`.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE, authHeaders, createTestApp, login, type Session } from './support/harness';

let app: NestFastifyApplication;
/** Holds documents.manage + documents.approve + documents.publish — the ISMS owner. */
let security: Session;
/** Wildcard, and NOT the author — the only principal that may approve what security wrote. */
let admin: Session;
/** No permission codes at all: must still see and acknowledge what binds them. */
let employee: Session;

let documentId: string;
let v1Id: string;

const CODE = `POL-E2E-${Date.now().toString(36).toUpperCase()}`;

async function post<T = Record<string, unknown>>(
  url: string,
  session: Session,
  payload: Record<string, unknown> = {},
): Promise<{ status: number; body: T }> {
  const res = await app.inject({ method: 'POST', url, headers: authHeaders(session), payload });
  return { status: res.statusCode, body: JSON.parse(res.body) as T };
}

async function get<T = Record<string, unknown>>(
  url: string,
  session: Session,
): Promise<{ status: number; body: T }> {
  const res = await app.inject({ method: 'GET', url, headers: authHeaders(session) });
  return { status: res.statusCode, body: JSON.parse(res.body) as T };
}

/** Versions newest-first, as the API returns them. */
async function versions(): Promise<{ id: string; version: number; status: string }[]> {
  const { status, body } = await get<{ id: string; version: number; status: string }[]>(
    `/v1/documents/${documentId}/versions`,
    security,
  );
  expect(status).toBe(200);
  return body;
}

async function outstanding(session: Session): Promise<{ code: string; version: number }[]> {
  const { status, body } = await get<{ code: string; version: number }[]>(
    '/v1/documents/acknowledgements/outstanding',
    session,
  );
  expect(status).toBe(200);
  return body;
}

/** Drive a version through approval by the ADMIN, since the author may not approve. */
async function approveAsAdmin(versionId: string): Promise<void> {
  const submitted = await post<{ requestId: string }>(
    `/v1/documents/versions/${versionId}/submit`,
    security,
  );
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
  const approved = await post(`/v1/requests/${submitted.body.requestId}/approve`, admin);
  // 200: `POST /requests/:id/approve` is a transition, not a creation. It always documented 200;
  // it now returns it. See test/post-status-contract.ratchet.spec.ts.
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
}

beforeAll(async () => {
  app = await createTestApp();
  security = await login(app, FIXTURE.SECURITY);
  admin = await login(app, FIXTURE.ADMIN);
  employee = await login(app, FIXTURE.NO_PERMISSIONS);

  const created = await post<{ id: string }>('/v1/documents', security, {
    code: CODE,
    title: 'Information Security Policy (e2e)',
    category: 'isms_policy',
    ownerId: FIXTURE.SECURITY.id,
    body: 'Version 1 text.',
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  documentId = created.body.id;

  const [first] = await versions();
  // Registered WITH its first draft: a document with no version has nothing to edit or publish.
  expect(first.version).toBe(1);
  expect(first.status).toBe('draft');
  v1Id = first.id;
});

afterAll(async () => {
  await app?.close();
});

describe('controlled document approval', () => {
  it('refuses to let the author approve their own policy', async () => {
    const submitted = await post<{ requestId: string; status: string }>(
      `/v1/documents/versions/${v1Id}/submit`,
      security,
    );
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    expect(submitted.body.status).toBe('in_review');

    // Separation of duties comes from RequestEngine's `allowSelfApproval: false`, so this asserts
    // the wiring rather than a local check — the whole reason approval is a RequestTypeDef.
    const selfApproved = await post(`/v1/requests/${submitted.body.requestId}/approve`, security);
    expect(selfApproved.status, JSON.stringify(selfApproved.body)).toBe(403);

    const approved = await post(`/v1/requests/${submitted.body.requestId}/approve`, admin);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  });

  it('marks the version approved WITHOUT publishing it', async () => {
    const [current] = await versions();
    expect(current.status).toBe('approved');

    // The distinction that keeps "in force on a date" answerable: approval is agreement that the
    // text is right, publication is the act of putting it into force.
    const outstandingNow = await outstanding(employee);
    expect(
      outstandingNow.some((o) => o.code === CODE),
      'an approved-but-unpublished version was already being demanded of employees',
    ).toBe(false);
  });

  it('refuses to acknowledge a version that is not published', async () => {
    const res = await post(`/v1/documents/versions/${v1Id}/acknowledge`, employee);
    expect(res.status, JSON.stringify(res.body)).toBe(412);
  });

  it('publishes, and the employee then owes an acknowledgement', async () => {
    const published = await post<{ publishedAt: string | null }>(
      `/v1/documents/versions/${v1Id}/publish`,
      admin,
      { reviewDueOn: '2028-01-01' },
    );
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    expect(published.body.publishedAt).not.toBeNull();

    const owed = await outstanding(employee);
    expect(owed.filter((o) => o.code === CODE)).toEqual([
      expect.objectContaining({ code: CODE, version: 1 }),
    ]);
  });

  it('records an acknowledgement once, however many times it is clicked', async () => {
    const first = await post<{ alreadyAcknowledged: boolean }>(
      `/v1/documents/versions/${v1Id}/acknowledge`,
      employee,
    );
    expect(first.status).toBe(200);
    expect(first.body.alreadyAcknowledged).toBe(false);

    const second = await post<{ alreadyAcknowledged: boolean }>(
      `/v1/documents/versions/${v1Id}/acknowledge`,
      employee,
    );
    expect(second.status).toBe(200);
    expect(
      second.body.alreadyAcknowledged,
      'a second click created a second acknowledgement instead of being idempotent',
    ).toBe(true);

    expect(
      (await outstanding(employee)).some((o) => o.code === CODE),
      'the document is still outstanding after being acknowledged',
    ).toBe(false);
  });
});

describe('naming the people a document points at', () => {
  /*
   * WHY THIS IS ASSERTED AT ALL. The SPA showed `ownerId` in the Owner column and a uuid per line in
   * the acknowledgement list, so the two questions those screens exist to answer — who is accountable
   * for this policy, and who has signed off on this revision — were answered with 36 characters that
   * identify nobody. The names have to come from the API: `GET /v1/employees` needs `employee.read`,
   * which a document reader is not required to hold, and the SPA cannot spend one request per row.
   */
  it('names the owner in the list and in the single document', async () => {
    const list = await get<{ data: { id: string; ownerId: string; ownerName: string | null }[] }>(
      '/v1/documents?limit=50',
      security,
    );
    expect(list.status).toBe(200);
    const mine = list.body.data.find((d) => d.id === documentId);
    expect(mine, 'the document under test is not in the library listing').toBeDefined();
    expect(
      mine!.ownerName,
      `document ${mine!.id} came back with owner ${mine!.ownerId} and no name`,
    ).toBeTruthy();

    const one = await get<{ ownerName: string | null }>(`/v1/documents/${documentId}`, security);
    expect(one.status).toBe(200);
    // The single-document read path resolves it too — it is a SEPARATE service method from the list,
    // so a change to one leaves the other showing a uuid.
    expect(one.body.ownerName).toBe(mine!.ownerName);
  });

  it('names who acknowledged a version', async () => {
    const acked = await get<{ employeeId: string; employeeName: string | null }[]>(
      `/v1/documents/versions/${v1Id}/acknowledgements`,
      security,
    );
    expect(acked.status, JSON.stringify(acked.body)).toBe(200);
    expect(acked.body.length, 'nobody has acknowledged v1, so this proves nothing').toBeGreaterThan(
      0,
    );
    for (const row of acked.body) {
      expect(
        row.employeeName,
        `acknowledgement by ${row.employeeId} came back with no name`,
      ).toBeTruthy();
    }
  });
});

describe('finding a document in the library', () => {
  it('searches over the code and the title, which is what a picker needs', async () => {
    /*
     * WHY THIS EXISTS. Documents are cited BY NAME from other records — an audit's report, a review's
     * minutes — through a picker. Without a server-side search a picker can only offer the first page, so
     * document 101 is unreachable and the record cites nothing. Asserted on both fields because a picker
     * user types whichever one they remember.
     */
    const byCode = await get<{ data: { id: string; code: string }[] }>(
      `/v1/documents?search=${encodeURIComponent(CODE)}`,
      security,
    );
    expect(byCode.status).toBe(200);
    expect(byCode.body.data.map((row) => row.code)).toContain(CODE);

    const byTitle = await get<{ data: { code: string }[] }>(
      '/v1/documents?search=Information%20Security',
      security,
    );
    expect(byTitle.status).toBe(200);
    expect(byTitle.body.data.map((row) => row.code)).toContain(CODE);

    // And it EXCLUDES: a search that matches nothing returns nothing, rather than the whole library.
    const miss = await get<{ data: unknown[] }>(
      '/v1/documents?search=zzz-no-such-document',
      security,
    );
    expect(miss.status).toBe(200);
    expect(miss.body.data).toHaveLength(0);
  });
});

describe('superseding a published document', () => {
  it('publishes v2, supersedes v1, and leaves exactly one version in force', async () => {
    const draft = await post<{ id: string; version: number }>(
      `/v1/documents/${documentId}/versions`,
      security,
      { body: 'Version 2 text.', changeSummary: 'Tightened MFA requirements' },
    );
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect(draft.body.version).toBe(2);

    await approveAsAdmin(draft.body.id);
    const published = await post(`/v1/documents/versions/${draft.body.id}/publish`, admin);
    expect(published.status, JSON.stringify(published.body)).toBe(200);

    const all = await versions();
    expect(all.map((v) => [v.version, v.status])).toEqual([
      [2, 'published'],
      [1, 'superseded'],
    ]);
    // `uq_document_published_version` makes this a database guarantee, not a convention — two
    // concurrent publishes cannot both land.
    expect(all.filter((v) => v.status === 'published')).toHaveLength(1);
  });

  it('makes the document outstanding AGAIN for someone who acknowledged v1', async () => {
    // The ISO rule, and the reason acknowledgements are keyed on the version rather than the
    // document: consent to v1 says nothing about v2. Keyed on the document, this employee would
    // still read as compliant against a policy they have never seen.
    const owed = await outstanding(employee);
    expect(owed.filter((o) => o.code === CODE)).toEqual([
      expect.objectContaining({ code: CODE, version: 2 }),
    ]);
  });

  it('refuses to edit a published version, directing the author to a new draft', async () => {
    const [current] = await versions();
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/documents/versions/${current.id}`,
      headers: authHeaders(security),
      payload: { body: 'sneaky in-place edit' },
    });

    // Immutability is what makes the revision history worth anything.
    expect(res.statusCode, res.body).toBe(412);
  });
});

describe('controlled document authorization', () => {
  it('refuses an employee authoring a document', async () => {
    const res = await post('/v1/documents', employee, {
      code: `POL-DENIED-${Date.now().toString(36)}`,
      title: 'Self-authored policy',
      category: 'isms_policy',
      ownerId: FIXTURE.NO_PERMISSIONS.id,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
  });

  it('refuses an employee browsing the library', async () => {
    // Deliberate: `documents.read` includes drafts and rejected revisions. What employees are
    // entitled to see is the published set they must acknowledge, which is the self-scoped
    // outstanding route — not the whole library.
    const res = await get('/v1/documents', employee);
    expect(res.status).toBe(403);
  });

  it('lets an employee see and acknowledge what binds them', async () => {
    const owed = await outstanding(employee);
    expect(owed.length).toBeGreaterThan(0);
  });
});
