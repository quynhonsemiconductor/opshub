/**
 * A record that cites a controlled document cites one that exists.
 *
 * FIVE COLUMNS ACROSS FOUR MODULES point at `documents.documents` over a schema boundary, so none of
 * them can carry a foreign key: the supplier DPA, the SoA control's evidence, a contract's signed
 * document, a vendor assessment's evidence and an internal audit's report. Every one was documented as
 * "checked by the service", and until this change nothing checked anything.
 *
 * WHY IT MATTERS MORE THAN A TYPO. A dangling reference is the worst kind of compliance record: it
 * reads as complete. An SoA citing evidence that does not exist is an ISO 27001 finding; a contract row
 * naming a document nobody can open is a signed contract on paper only; an audit whose report pointer
 * resolves to nothing cannot produce the record ISO 9001 §9.2 requires it to keep.
 *
 * WHY AN E2E. `DocumentsService.assertExist` is unit-tested, but four of these five assertions are
 * about a CONTROLLER calling it on the route that accepts the field — and the fifth is about the status
 * of the refusal, which the exception filter decides. A unit test of the service cannot see any of that,
 * and the defect was precisely a check that existed somewhere and was never called.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d` and `pnpm db:seed`.
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

/** A well-formed uuid that names no controlled document. */
const NO_SUCH_DOCUMENT = '00000000-0000-4000-8000-00000000dead';

let app: NestFastifyApplication;
let security: Session;
let hr: Session;

let seq = 0;
const nextRef = (p: string) => `E2E-${p}-${Date.now().toString(36).toUpperCase()}-${++seq}`;

beforeAll(async () => {
  app = await createTestApp();
  security = await login(app, FIXTURE.SECURITY);
  hr = await login(app, FIXTURE.HR);
}, 60_000);

afterAll(async () => {
  await app?.close();
});

/**
 * A control from the Annex A CATALOGUE, which is reference data and survives the suite's reset.
 *
 * NOT from `GET /controls/soa`, which lists ENTRIES — `resetFixtureTables` truncates those, so that
 * route starts empty and my first draft asserted the catalogue was unseeded when it was the entries
 * that were gone. `PUT /controls/soa/:controlId` is the route that CREATES an entry, so a catalogue id
 * is what it wants.
 */
async function annexAControl(): Promise<string> {
  const res = await apiRequest(app, security, 'GET', '/controls?limit=1');
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const rows = unwrap<{ id: string }[]>(res.body);
  expect(rows.length, 'the Annex A control catalogue is not seeded').toBeGreaterThan(0);
  return rows[0].id;
}

/** A real controlled document, so the accept side of every pair is not a guess. */
async function realDocument(): Promise<string> {
  const res = await apiRequest(app, security, 'POST', '/documents', {
    code: nextRef('DOC'),
    title: 'Evidence of control operation',
    category: 'isms_policy',
    ownerId: FIXTURE.SECURITY.id,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return unwrap<{ id: string }>(res.body).id;
}

describe('an unknown controlled document is refused, by name', () => {
  it('on a Statement of Applicability entry', async () => {
    const res = await apiRequest(app, security, 'PUT', `/controls/soa/${await annexAControl()}`, {
      applicable: true,
      justification: 'Checking the evidence reference guard.',
      status: 'implemented',
      evidenceDocumentId: NO_SUCH_DOCUMENT,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(errorCode(res.body)).toBe('NOT_FOUND');
    // The id, so the caller knows WHICH reference to correct.
    expect(JSON.stringify(res.body)).toContain(NO_SUCH_DOCUMENT);
  });

  it('and accepts a real one on the same route', async () => {
    // The accept side. Without it, a guard that refused every reference would satisfy the case above.
    const documentId = await realDocument();
    const res = await apiRequest(app, security, 'PUT', `/controls/soa/${await annexAControl()}`, {
      applicable: true,
      justification: 'Checking the evidence reference guard accepts a real document.',
      status: 'implemented',
      evidenceDocumentId: documentId,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('on a contract draft', async () => {
    const res = await apiRequest(app, hr, 'POST', '/contracts', {
      reference: nextRef('CON'),
      employeeId: FIXTURE.NO_PERMISSIONS.id,
      contractType: 'permanent',
      startDate: '2026-09-01',
      documentId: NO_SUCH_DOCUMENT,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(errorCode(res.body)).toBe('NOT_FOUND');
  });

  it('on a contract CORRECTION, not only the draft route', async () => {
    /*
     * The PATCH accepts `documentId` too, and it is the route somebody uses after mistyping it the
     * first time — so guarding only the draft would leave the likelier path open.
     */
    const created = await apiRequest(app, hr, 'POST', '/contracts', {
      reference: nextRef('CON'),
      employeeId: FIXTURE.NO_PERMISSIONS.id,
      contractType: 'permanent',
      startDate: '2026-09-01',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = unwrap<{ id: string }>(created.body).id;

    const res = await apiRequest(app, hr, 'PATCH', `/contracts/${id}`, {
      documentId: NO_SUCH_DOCUMENT,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(errorCode(res.body)).toBe('NOT_FOUND');
  });

  it('on a vendor assessment', async () => {
    const vendor = await apiRequest(app, security, 'POST', '/vendors', {
      reference: nextRef('VEN'),
      name: 'Reference guard supplier',
      services: 'Holds nothing; exists to check a document reference.',
      criticality: 'low',
      ownerId: FIXTURE.SECURITY.id,
    });
    expect(vendor.status, JSON.stringify(vendor.body)).toBe(201);

    const res = await apiRequest(
      app,
      security,
      'POST',
      `/vendors/${unwrap<{ id: string }>(vendor.body).id}/assessments`,
      {
        outcome: 'pass',
        scope: 'Reviewed the SOC 2 report and the agreement in full.',
        evidenceDocumentId: NO_SUCH_DOCUMENT,
      },
    );

    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(errorCode(res.body)).toBe('NOT_FOUND');
  });

  it("on an internal audit's report", async () => {
    /*
     * ADDED BECAUSE A MUTATION SURVIVED. Deleting this guard changed nothing, and the reason was
     * embarrassing: I had verified the route by hand with curl and never written a test, so the only
     * evidence it worked was a terminal I had closed.
     *
     * ISO 9001 §9.2 keeps the audit RESULT as the record and this column is the only pointer to it, so
     * a dangling one is an audit whose report cannot be produced.
     */
    const planned = await apiRequest(app, security, 'POST', '/internal-audits', {
      reference: nextRef('AUD'),
      title: 'Reference guard audit',
      objective: 'Confirm the report document reference is validated on the route that accepts it.',
      scope: 'The reporting transition only.',
      criteria: 'ISO 9001:2015 §9.2 and the internal audit procedure.',
      leadAuditorId: FIXTURE.SECURITY.id,
    });
    expect(planned.status, JSON.stringify(planned.body)).toBe(201);
    const auditId = unwrap<{ id: string }>(planned.body).id;

    const started = await apiRequest(
      app,
      security,
      'POST',
      `/internal-audits/${auditId}/start`,
      {},
    );
    expect(started.status, JSON.stringify(started.body)).toBe(200);

    const res = await apiRequest(app, security, 'POST', `/internal-audits/${auditId}/report`, {
      conclusion: 'Reported with a document id that names nothing, to check the guard.',
      reportDocumentId: NO_SUCH_DOCUMENT,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(errorCode(res.body)).toBe('NOT_FOUND');

    // And the real one is accepted, so the guard is about the reference and not the route.
    const ok = await apiRequest(app, security, 'POST', `/internal-audits/${auditId}/report`, {
      conclusion: 'Reported with a real controlled document.',
      reportDocumentId: await realDocument(),
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('lets a reference be cleared to null, which is not an unknown document', async () => {
    // `null` is the absence of a reference, not a bad one. Resolving it would refuse the only way to
    // unlink a document.
    const created = await apiRequest(app, hr, 'POST', '/contracts', {
      reference: nextRef('CON'),
      employeeId: FIXTURE.NO_PERMISSIONS.id,
      contractType: 'permanent',
      startDate: '2026-09-01',
    });
    expect(created.status).toBe(201);
    const res = await apiRequest(
      app,
      hr,
      'PATCH',
      `/contracts/${unwrap<{ id: string }>(created.body).id}`,
      { documentId: null },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});

describe('an unknown risk or asset on a REPORTED incident', () => {
  it('is a 404 naming the field, not the 500 it used to be', async () => {
    /*
     * `PATCH /incidents/:id` was fixed earlier; `POST /incidents/report` kept the defect, and it is the
     * one route in the module that needs no permission at all — so the raw 500 was reachable by
     * anybody who could log in.
     */
    const res = await apiRequest(app, security, 'POST', '/incidents/report', {
      reference: nextRef('INC'),
      title: 'Reference guard check',
      description: 'Reported with a risk id that names nothing.',
      category: 'phishing',
      severity: 'low',
      detectedAt: new Date(Date.now() - 3_600_000).toISOString(),
      riskId: NO_SUCH_DOCUMENT,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(errorCode(res.body)).toBe('NOT_FOUND');
    expect(JSON.stringify(res.body)).toContain('riskId');
  });

  it('still reports an incident that cites nothing', async () => {
    // The accept side: most incidents are raised before anybody knows which risk they belong to.
    const res = await apiRequest(app, security, 'POST', '/incidents/report', {
      reference: nextRef('INC'),
      title: 'Reference guard check, no references',
      description: 'Reported with no risk or asset at all.',
      category: 'phishing',
      severity: 'low',
      detectedAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });
});
