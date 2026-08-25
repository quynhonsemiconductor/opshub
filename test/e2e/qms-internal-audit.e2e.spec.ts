/**
 * QMS internal audit end to end: the programme, the roster, and the impartiality rule.
 *
 * WHAT THIS EXISTS TO PIN
 * -----------------------
 *   - SCOPE AND CRITERIA ARE BOTH REQUIRED — §9.2.2(b). They answer different questions, and an audit
 *     missing either cannot be repeated or defended.
 *   - FIELDWORK NEEDS AUDITORS. Removing everybody and trying to start is a coded 412, not a silent
 *     success — a count over another table, so no CHECK can hold it.
 *   - REPORTING IS NOT SKIPPABLE. `in_progress → closed` is refused; closing goes through `reported`,
 *     which itself requires a conclusion AND a report document. §9.2.2(d) makes reporting its own
 *     obligation, so an audit whose results never reached anybody cannot be marked done.
 *   - THE LEAD IS ALWAYS ON THE ROSTER. Planning puts them there; re-assigning `lead` moves the
 *     previous one to `auditor` rather than dropping them; removing the lead is refused outright.
 *   - THE IMPARTIALITY RULE, which is the point of the roster: somebody who audited a finding cannot
 *     sign off that the corrective action for it worked (§9.2.2(c)) — in BOTH review directions, and
 *     even holding the wildcard. An `observer` on the same audit CAN.
 *   - THE TRACEABILITY GAP is a report, not a constraint: an `internal_audit` finding naming no audit
 *     appears on `reports/unlinked-findings` and drops off once linked.
 *
 * REFERENCES ARE UNIQUE PER RUN — `uq_internal_audit_reference` and `uq_nc_reference` are global and
 * the database is shared with the other suites.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d`, `pnpm db:migrate`, `pnpm db:seed`.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { internalAuditStatusEnum } from '../../db/schema/enums';
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
/** Holds `internal_audit.*`, `nonconformance.*` and `capa.manage` — but NOT `capa.verify`. */
let security: Session;
/** Holds the read half only. */
let auditor: Session;
/** Holds the wildcard, so the only identity here that can verify a CAPA. */
let admin: Session;
/** Holds no permission codes at all. */
let employee: Session;

const RUN = Date.now().toString(36).toUpperCase().slice(-6);
let seq = 0;
const nextAudit = (): string => `E2E-IA-${RUN}-${++seq}`;
const nextNc = (): string => `E2E-IANC-${RUN}-${++seq}`;
const nextCapa = (): string => `E2E-IACAPA-${RUN}-${++seq}`;

const OBJECTIVE = 'Establish whether purchasing follows SOP-4 from requisition to payment.';
const SCOPE = 'Purchasing and supplier onboarding, Hanoi site, the January to March period.';
const CRITERIA = 'ISO 9001 clause 8.4 and SOP-4 revision 3';
const CONCLUSION = 'Two minor findings raised; the approval control is otherwise effective.';
const CONTAINMENT = 'We re-ran the approval with two signatories and re-issued the release note.';
const CAUSE = 'The pipeline accepted a single approver because the branch rule was advisory only.';
const PLAN = 'Make the branch rule blocking and add a gate that fails on one approval.';
const EVIDENCE = 'Re-audited ten releases after the change; the gate blocked two single approvals.';
const REASON = 'The site closed for refurbishment before fieldwork could begin.';

/** A document id stands in for the controlled report — no cross-schema FK, so any uuid is accepted. */
const REPORT_DOC = '00000000-0000-7000-8000-00000000d0c1';

interface AuditRow {
  id: string;
  reference: string;
  status: string;
  leadAuditorId: string;
  /** Resolved server-side on the READ paths. Null only when the employee row is gone. */
  leadAuditorName: string | null;
  startedAt: string | null;
  reportedAt: string | null;
  conclusion: string | null;
  reportDocumentId: string | null;
  closedAt: string | null;
  cancelReason: string | null;
}
interface AuditListRow extends AuditRow {
  auditorCount: number;
  findingCount: number;
  openFindingCount: number;
}
interface RosterRow {
  auditorId: string;
  /** Resolved server-side. Null only when the employee row is gone; the roster row stays. */
  auditorName: string | null;
  role: string;
}
interface FindingRow {
  id: string;
  reference: string;
  severity: string;
  status: string;
}
interface CapaRow {
  id: string;
  status: string;
}

/**
 * The programme row for one audit, found by EXACT reference.
 *
 * `search` is a substring match and the references in this file are sequential, so `E2E-IA-X-1` also
 * matches `E2E-IA-X-10`. Taking `[0]` off a search result therefore reads a different audit's counts
 * once the run passes ten audits — which is exactly how this file first failed, with a count of 0
 * against an audit that really had two findings.
 */
async function programmeRow(reference: string): Promise<AuditListRow> {
  const rows = unwrap<AuditListRow[]>(
    (await apiRequest(app, security, 'GET', `/internal-audits?search=${reference}&limit=100`)).body,
  );
  const row = rows.find((r) => r.reference === reference);
  expect(row, `no programme row for ${reference}`).toBeDefined();
  return row!;
}

/** Plan an audit led by SECURITY. Overrides first, session second. */
async function planAudit(over: Record<string, unknown> = {}): Promise<AuditRow> {
  const res = await apiRequest(app, security, 'POST', '/internal-audits', {
    reference: nextAudit(),
    title: 'Purchasing process audit',
    objective: OBJECTIVE,
    scope: SCOPE,
    criteria: CRITERIA,
    leadAuditorId: FIXTURE.SECURITY.id,
    ...over,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return unwrap<AuditRow>(res.body);
}

/** Raise a finding, optionally against an audit. */
async function raiseFinding(over: Record<string, unknown> = {}): Promise<FindingRow> {
  const res = await apiRequest(app, security, 'POST', '/nonconformances/report', {
    reference: nextNc(),
    title: 'Two approvals required, one recorded',
    description: 'The release was approved by one person where the procedure requires two.',
    requirement: 'SOP-12 section 4 requires two approvals before release.',
    source: 'internal_audit',
    severity: 'major',
    processArea: `purchasing-${RUN}`,
    ownerId: FIXTURE.SECURITY.id,
    ...over,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return unwrap<FindingRow>(res.body);
}

/** Drive a finding's CAPA to `implemented`, owned by HR so ownership never masks impartiality. */
async function implementedCapaFor(findingId: string): Promise<CapaRow> {
  const opened = await apiRequest(app, security, 'POST', `/capas/for/${findingId}`, {
    reference: nextCapa(),
    ownerId: FIXTURE.HR.id,
  });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  const capa = unwrap<CapaRow>(opened.body);

  await apiRequest(app, security, 'POST', `/capas/${capa.id}/analysis`, {
    rootCause: CAUSE,
    rootCauseMethod: 'five_whys',
    actionPlan: PLAN,
  });
  for (const step of ['plan', 'start'] as const) {
    const res = await apiRequest(app, security, 'POST', `/capas/${capa.id}/${step}`);
    expect(res.status, step).toBe(200);
  }
  const impl = await apiRequest(app, security, 'POST', `/capas/${capa.id}/implemented`, {});
  expect(impl.status, JSON.stringify(impl.body)).toBe(200);
  return unwrap<CapaRow>(impl.body);
}

beforeAll(async () => {
  app = await createTestApp();
  security = await login(app, FIXTURE.SECURITY);
  auditor = await login(app, FIXTURE.AUDITOR);
  admin = await login(app, FIXTURE.ADMIN);
  employee = await login(app, FIXTURE.NO_PERMISSIONS);
}, 60_000);

afterAll(async () => {
  await app?.close();
});

describe('planning', () => {
  it('plans an audit and puts the lead on the roster', async () => {
    const audit = await planAudit();
    expect(audit.status).toBe('planned');

    const roster = unwrap<RosterRow[]>(
      (await apiRequest(app, security, 'GET', `/internal-audits/${audit.id}/auditors`)).body,
    );
    // Invariant: the lead is on the roster from the moment the audit exists, so the impartiality rule
    // can see them without anybody remembering a second call.
    expect(roster).toHaveLength(1);
    expect(roster[0]).toMatchObject({ auditorId: FIXTURE.SECURITY.id, role: 'lead' });
  });

  it('refuses an audit with no criteria', async () => {
    const res = await apiRequest(app, security, 'POST', '/internal-audits', {
      reference: nextAudit(),
      title: 'Criteria-free audit',
      objective: OBJECTIVE,
      scope: SCOPE,
      criteria: 'x',
      leadAuditorId: FIXTURE.SECURITY.id,
    });
    // §9.2.2(b). Refused at validation, so never a 500 from the CHECK behind it.
    expect(res.status).toBe(422);
  });

  it('refuses a planned window that runs backwards', async () => {
    const res = await apiRequest(app, security, 'POST', '/internal-audits', {
      reference: nextAudit(),
      title: 'Backwards window audit',
      objective: OBJECTIVE,
      scope: SCOPE,
      criteria: CRITERIA,
      leadAuditorId: FIXTURE.SECURITY.id,
      plannedStartOn: '2027-01-01',
      plannedEndOn: '2026-01-01',
    });
    expect(res.status).toBe(412);
    expect(errorCode(res.body)).toBe('INTERNAL_AUDIT_INVALID_WINDOW');
  });

  it('refuses a lead auditor who does not exist', async () => {
    const res = await apiRequest(app, security, 'POST', '/internal-audits', {
      reference: nextAudit(),
      title: 'Phantom lead audit',
      objective: OBJECTIVE,
      scope: SCOPE,
      criteria: CRITERIA,
      leadAuditorId: '00000000-0000-7000-8000-0000000000ff',
    });
    expect(res.status).toBe(404);
  });

  it('refuses a duplicate reference', async () => {
    const audit = await planAudit();
    const res = await apiRequest(app, security, 'POST', '/internal-audits', {
      reference: audit.reference,
      title: 'Duplicate reference audit',
      objective: OBJECTIVE,
      scope: SCOPE,
      criteria: CRITERIA,
      leadAuditorId: FIXTURE.SECURITY.id,
    });
    expect(res.status).toBe(409);
    expect(errorCode(res.body)).toBe('CONFLICT');
  });
});

describe('the roster', () => {
  it('adds an auditor, then changes their role in place', async () => {
    const audit = await planAudit();
    for (const role of ['observer', 'auditor'] as const) {
      const res = await apiRequest(
        app,
        security,
        'PUT',
        `/internal-audits/${audit.id}/auditors/${FIXTURE.HR.id}`,
        { role },
      );
      expect(res.status, role).toBe(204);
    }
    const roster = unwrap<RosterRow[]>(
      (await apiRequest(app, security, 'GET', `/internal-audits/${audit.id}/auditors`)).body,
    );
    // Idempotent on the pair: re-adding changed the role rather than failing.
    expect(roster).toHaveLength(2);
    expect(roster.find((r) => r.auditorId === FIXTURE.HR.id)!.role).toBe('auditor');
  });

  it('refuses to remove the lead, and moves them aside when a new lead is assigned', async () => {
    const audit = await planAudit();

    const removed = await apiRequest(
      app,
      security,
      'DELETE',
      `/internal-audits/${audit.id}/auditors/${FIXTURE.SECURITY.id}`,
    );
    expect(removed.status).toBe(412);
    expect(errorCode(removed.body)).toBe('INTERNAL_AUDIT_LEAD_REQUIRED');

    // Assigning a new lead is the supported way, and the previous lead stays on as `auditor` — they
    // may well have done fieldwork, and dropping them would erase that from the impartiality rule.
    const promoted = await apiRequest(
      app,
      security,
      'PUT',
      `/internal-audits/${audit.id}/auditors/${FIXTURE.HR.id}`,
      { role: 'lead' },
    );
    expect(promoted.status).toBe(204);

    const after = unwrap<AuditRow>(
      (await apiRequest(app, security, 'GET', `/internal-audits/${audit.id}`)).body,
    );
    expect(after.leadAuditorId).toBe(FIXTURE.HR.id);

    const roster = unwrap<RosterRow[]>(
      (await apiRequest(app, security, 'GET', `/internal-audits/${audit.id}/auditors`)).body,
    );
    expect(roster.find((r) => r.auditorId === FIXTURE.HR.id)!.role).toBe('lead');
    expect(roster.find((r) => r.auditorId === FIXTURE.SECURITY.id)!.role).toBe('auditor');
  });

  it('counts auditors but not observers on the programme row', async () => {
    const audit = await planAudit();
    await apiRequest(
      app,
      security,
      'PUT',
      `/internal-audits/${audit.id}/auditors/${FIXTURE.HR.id}`,
      {
        role: 'observer',
      },
    );
    const row = await programmeRow(audit.reference);
    // The lead only. An observer did not audit, and the count is what a reader judges coverage by.
    expect(row.auditorCount).toBe(1);
  });
});

describe('naming the people rather than showing uuids', () => {
  /*
   * WHY THIS IS ASSERTED AT ALL. The programme drawer rendered `leadAuditorId` and the roster rendered
   * a column of uuids, so the two lines in this module that have to name somebody named nobody. It is
   * worst on the roster: being on it is what bars a person from certifying a fix for this audit's
   * findings under §9.2.2(c), so a screen that cannot say who is on it cannot explain the refusal it
   * causes. The API has to resolve it — `GET /v1/employees` needs `employee.read`, which
   * `internal_audit.read` does not imply.
   */
  it('names the lead auditor on the programme row and on the single audit', async () => {
    const audit = await planAudit();

    // `programmeRow` matches on the EXACT reference, for the substring reason in its docblock.
    const row = await programmeRow(audit.reference);
    expect(
      row.leadAuditorName,
      `audit ${row.reference} came back with lead ${row.leadAuditorId} and no name`,
    ).toBeTruthy();

    // The single-audit read is a SEPARATE service method — `getWithLeadAuditor`, added rather than
    // widening the `getById` that nine write paths share — so it needs its own assertion. One of the
    // two showing a uuid is the state this change was made to end.
    const one = await apiRequest(app, security, 'GET', `/internal-audits/${audit.id}`);
    expect(one.status).toBe(200);
    expect(unwrap<AuditRow>(one.body).leadAuditorName).toBe(row.leadAuditorName);
  });

  it('gives two different auditors two different names', async () => {
    /*
     * THE ASSERTION WORTH HAVING ON A ROSTER. Every row here carries TWO employee columns — the person
     * who audited and the person who put them on — so a resolver keyed on `addedBy` instead of
     * `auditorId` would still return a name for every row, and every one of them would be the same
     * name. Two distinct people on one roster is the only shape that catches it.
     */
    const audit = await planAudit();
    const added = await apiRequest(
      app,
      security,
      'PUT',
      `/internal-audits/${audit.id}/auditors/${FIXTURE.HR.id}`,
      { role: 'auditor' },
    );
    expect(added.status, JSON.stringify(added.body)).toBe(204);

    const roster = unwrap<RosterRow[]>(
      (await apiRequest(app, security, 'GET', `/internal-audits/${audit.id}/auditors`)).body,
    );
    const lead = roster.find((r) => r.auditorId === FIXTURE.SECURITY.id)!;
    const second = roster.find((r) => r.auditorId === FIXTURE.HR.id)!;
    expect(lead.auditorName, `lead ${lead.auditorId} came back with no name`).toBeTruthy();
    expect(second.auditorName, `auditor ${second.auditorId} came back with no name`).toBeTruthy();
    // Both were added BY security, so this is what fails if the lookup reads the wrong column.
    expect(second.auditorName).not.toBe(lead.auditorName);
  });
});

describe('the lifecycle', () => {
  it('refuses to start with nobody rostered', async () => {
    // The lead is removed by promoting somebody else, then removing them — the only way to empty a
    // roster, and exactly the state the guard exists for.
    const audit = await planAudit();
    await apiRequest(
      app,
      security,
      'PUT',
      `/internal-audits/${audit.id}/auditors/${FIXTURE.HR.id}`,
      {
        role: 'lead',
      },
    );
    await apiRequest(
      app,
      security,
      'PUT',
      `/internal-audits/${audit.id}/auditors/${FIXTURE.SECURITY.id}`,
      { role: 'observer' },
    );
    await apiRequest(
      app,
      security,
      'DELETE',
      `/internal-audits/${audit.id}/auditors/${FIXTURE.SECURITY.id}`,
    );
    // HR is now the lead, so demote them to observer to leave nobody auditing.
    await apiRequest(
      app,
      security,
      'PUT',
      `/internal-audits/${audit.id}/auditors/${FIXTURE.ADMIN.id}`,
      {
        role: 'lead',
      },
    );
    await apiRequest(
      app,
      security,
      'PUT',
      `/internal-audits/${audit.id}/auditors/${FIXTURE.HR.id}`,
      {
        role: 'observer',
      },
    );
    await apiRequest(
      app,
      security,
      'PUT',
      `/internal-audits/${audit.id}/auditors/${FIXTURE.ADMIN.id}`,
      {
        role: 'observer',
      },
    );

    const res = await apiRequest(app, security, 'POST', `/internal-audits/${audit.id}/start`, {});
    expect(res.status).toBe(412);
    expect(errorCode(res.body)).toBe('INTERNAL_AUDIT_NO_AUDITORS');
  });

  it('walks planned to closed through reported', async () => {
    const audit = await planAudit();
    const started = await apiRequest(
      app,
      security,
      'POST',
      `/internal-audits/${audit.id}/start`,
      {},
    );
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(unwrap<AuditRow>(started.body).startedAt).not.toBeNull();

    const reported = await apiRequest(
      app,
      security,
      'POST',
      `/internal-audits/${audit.id}/report`,
      {
        conclusion: CONCLUSION,
        reportDocumentId: REPORT_DOC,
      },
    );
    expect(reported.status, JSON.stringify(reported.body)).toBe(200);
    expect(unwrap<AuditRow>(reported.body)).toMatchObject({
      status: 'reported',
      conclusion: CONCLUSION,
      reportDocumentId: REPORT_DOC,
    });

    const closed = await apiRequest(app, security, 'POST', `/internal-audits/${audit.id}/close`);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(unwrap<AuditRow>(closed.body).closedAt).not.toBeNull();
  });

  it('refuses to close an audit that never reported', async () => {
    // §9.2.2(d): results reaching management is its own obligation, so `closed` is only reachable
    // from `reported`. The state machine and `ck_audit_reported_pair` both say so.
    const audit = await planAudit();
    await apiRequest(app, security, 'POST', `/internal-audits/${audit.id}/start`, {});
    const res = await apiRequest(app, security, 'POST', `/internal-audits/${audit.id}/close`);
    expect(res.status).toBe(412);
    expect(errorCode(res.body)).toBe('INTERNAL_AUDIT_NOT_IN_STATE');
  });

  it('refuses to report without a conclusion', async () => {
    const audit = await planAudit();
    await apiRequest(app, security, 'POST', `/internal-audits/${audit.id}/start`, {});
    const res = await apiRequest(app, security, 'POST', `/internal-audits/${audit.id}/report`, {
      reportDocumentId: REPORT_DOC,
    });
    expect(res.status).toBe(422);
  });

  it('cancels a planned audit but not a reported one', async () => {
    const cancellable = await planAudit();
    const cancelled = await apiRequest(
      app,
      security,
      'POST',
      `/internal-audits/${cancellable.id}/cancel`,
      {
        reason: REASON,
      },
    );
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(unwrap<AuditRow>(cancelled.body)).toMatchObject({
      status: 'cancelled',
      cancelReason: REASON,
    });

    // Once results have been reported the audit happened, and the record of it is not cancellable.
    const reported = await planAudit();
    await apiRequest(app, security, 'POST', `/internal-audits/${reported.id}/start`, {});
    await apiRequest(app, security, 'POST', `/internal-audits/${reported.id}/report`, {
      conclusion: CONCLUSION,
      reportDocumentId: REPORT_DOC,
    });
    const refused = await apiRequest(
      app,
      security,
      'POST',
      `/internal-audits/${reported.id}/cancel`,
      {
        reason: REASON,
      },
    );
    expect(refused.status).toBe(412);
    expect(errorCode(refused.body)).toBe('INTERNAL_AUDIT_NOT_IN_STATE');
  });

  it('accepts nothing further once settled', async () => {
    const audit = await planAudit();
    await apiRequest(app, security, 'POST', `/internal-audits/${audit.id}/cancel`, {
      reason: REASON,
    });

    const patched = await apiRequest(app, security, 'PATCH', `/internal-audits/${audit.id}`, {
      title: 'Renamed after cancellation',
    });
    expect(patched.status).toBe(412);
    expect(errorCode(patched.body)).toBe('INTERNAL_AUDIT_SETTLED');

    const rostered = await apiRequest(
      app,
      security,
      'PUT',
      `/internal-audits/${audit.id}/auditors/${FIXTURE.HR.id}`,
      { role: 'auditor' },
    );
    expect(rostered.status).toBe(412);
    expect(errorCode(rostered.body)).toBe('INTERNAL_AUDIT_SETTLED');
  });

  it('covers every status the enum allows', () => {
    // Synchronous on purpose — there is nothing to await, and the lint rule is right to say so. The
    // tests above reach `planned`, `in_progress`, `reported`, `closed` and `cancelled` through the
    // API, so this pins that the enum holds exactly those and nothing decorative.
    expect(new Set(internalAuditStatusEnum.enumValues)).toEqual(
      new Set(['planned', 'in_progress', 'reported', 'closed', 'cancelled']),
    );
  });
});

describe('findings', () => {
  it('lists a finding raised against the audit, worst grade first', async () => {
    const audit = await planAudit();
    const minor = await raiseFinding({ internalAuditId: audit.id, severity: 'minor' });
    const major = await raiseFinding({ internalAuditId: audit.id, severity: 'major' });

    const findings = unwrap<FindingRow[]>(
      (await apiRequest(app, security, 'GET', `/internal-audits/${audit.id}/findings`)).body,
    );
    expect(findings.map((f) => f.reference)).toEqual([major.reference, minor.reference]);
  });

  it('counts findings and open findings on the programme row', async () => {
    const audit = await planAudit();
    await raiseFinding({ internalAuditId: audit.id, severity: 'minor' });
    const second = await raiseFinding({ internalAuditId: audit.id, severity: 'minor' });
    // Contain and close the second, so the two counts differ.
    await apiRequest(app, security, 'POST', `/nonconformances/${second.id}/contain`, {
      containmentAction: CONTAINMENT,
    });
    await apiRequest(app, security, 'POST', `/nonconformances/${second.id}/close`, {
      closureNote: 'Re-audited the control; it now holds.',
    });

    const row = await programmeRow(audit.reference);
    expect(row.findingCount).toBe(2);
    expect(row.openFindingCount).toBe(1);
  });

  it('reports an internal-audit finding that names no audit, and drops it once linked', async () => {
    const orphan = await raiseFinding({ source: 'internal_audit' });
    const before = unwrap<{ id: string }[]>(
      (await apiRequest(app, security, 'GET', '/internal-audits/reports/unlinked-findings')).body,
    );
    expect(before.map((f) => f.id)).toContain(orphan.id);

    const audit = await planAudit();
    const linked = await apiRequest(app, security, 'PATCH', `/nonconformances/${orphan.id}`, {
      internalAuditId: audit.id,
    });
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);

    const after = unwrap<{ id: string }[]>(
      (await apiRequest(app, security, 'GET', '/internal-audits/reports/unlinked-findings')).body,
    );
    expect(after.map((f) => f.id)).not.toContain(orphan.id);
  });

  it('does not report a finding from another source', async () => {
    // A customer complaint has no audit to name, so it is not a traceability gap.
    const complaint = await raiseFinding({ source: 'customer_complaint' });
    const rows = unwrap<{ id: string }[]>(
      (await apiRequest(app, security, 'GET', '/internal-audits/reports/unlinked-findings')).body,
    );
    expect(rows.map((f) => f.id)).not.toContain(complaint.id);
  });
});

describe('the impartiality rule', () => {
  it('refuses an effectiveness review from somebody who audited the finding', async () => {
    // The point of the roster. ADMIN holds the wildcard AND does not own the CAPA (HR does), so the
    // only thing that can refuse them is having audited.
    const audit = await planAudit();
    await apiRequest(
      app,
      security,
      'PUT',
      `/internal-audits/${audit.id}/auditors/${FIXTURE.ADMIN.id}`,
      {
        role: 'auditor',
      },
    );
    const finding = await raiseFinding({ internalAuditId: audit.id });
    const capa = await implementedCapaFor(finding.id);

    const res = await apiRequest(app, admin, 'POST', `/capas/${capa.id}/verify`, {
      effectivenessEvidence: EVIDENCE,
    });
    expect(res.status).toBe(412);
    expect(errorCode(res.body)).toBe('CAPA_AUDITOR_IMPARTIALITY');
  });

  it('refuses the auditor in the FAILING direction too', async () => {
    // A review the auditor may fail but not pass is still the auditor deciding.
    const audit = await planAudit();
    await apiRequest(
      app,
      security,
      'PUT',
      `/internal-audits/${audit.id}/auditors/${FIXTURE.ADMIN.id}`,
      {
        role: 'auditor',
      },
    );
    const finding = await raiseFinding({ internalAuditId: audit.id });
    const capa = await implementedCapaFor(finding.id);

    const res = await apiRequest(app, admin, 'POST', `/capas/${capa.id}/ineffective`, {
      reason: 'The gate was bypassed twice using an administrative override.',
    });
    expect(res.status).toBe(412);
    expect(errorCode(res.body)).toBe('CAPA_AUDITOR_IMPARTIALITY');
  });

  it('allows an OBSERVER on the same audit to verify', async () => {
    // Sitting in on fieldwork to learn does not compromise a later review, which is why `observer`
    // exists as a role at all.
    const audit = await planAudit();
    await apiRequest(
      app,
      security,
      'PUT',
      `/internal-audits/${audit.id}/auditors/${FIXTURE.ADMIN.id}`,
      {
        role: 'observer',
      },
    );
    const finding = await raiseFinding({ internalAuditId: audit.id });
    const capa = await implementedCapaFor(finding.id);

    const res = await apiRequest(app, admin, 'POST', `/capas/${capa.id}/verify`, {
      effectivenessEvidence: EVIDENCE,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(unwrap<CapaRow>(res.body).status).toBe('verified');
  });

  it('allows somebody who audited a DIFFERENT audit to verify', async () => {
    // The rule is about this finding's audit, not about being an auditor in general.
    const audited = await planAudit();
    await apiRequest(
      app,
      security,
      'PUT',
      `/internal-audits/${audited.id}/auditors/${FIXTURE.ADMIN.id}`,
      {
        role: 'auditor',
      },
    );
    const other = await planAudit();
    const finding = await raiseFinding({ internalAuditId: other.id });
    const capa = await implementedCapaFor(finding.id);

    const res = await apiRequest(app, admin, 'POST', `/capas/${capa.id}/verify`, {
      effectivenessEvidence: EVIDENCE,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('allows the review when the finding names no audit', async () => {
    // The traceability gap again: an unrecorded link cannot be enforced on, and refusing every
    // review because a link is missing would punish the wrong person.
    const finding = await raiseFinding({ internalAuditId: null });
    const capa = await implementedCapaFor(finding.id);
    const res = await apiRequest(app, admin, 'POST', `/capas/${capa.id}/verify`, {
      effectivenessEvidence: EVIDENCE,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('closes the finding once an impartial review passes', async () => {
    // The whole chain end to end: audit → finding → CAPA → impartial verification → closure.
    const audit = await planAudit();
    const finding = await raiseFinding({ internalAuditId: audit.id, severity: 'major' });
    await apiRequest(app, security, 'POST', `/nonconformances/${finding.id}/contain`, {
      containmentAction: CONTAINMENT,
    });
    const capa = await implementedCapaFor(finding.id);
    // ADMIN is not on this audit's roster and does not own the CAPA.
    const verified = await apiRequest(app, admin, 'POST', `/capas/${capa.id}/verify`, {
      effectivenessEvidence: EVIDENCE,
    });
    expect(verified.status, JSON.stringify(verified.body)).toBe(200);

    const closed = await apiRequest(app, security, 'POST', `/nonconformances/${finding.id}/close`, {
      closureNote: 'Corrective action verified effective by an impartial reviewer.',
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  });
});

describe('permissions', () => {
  it('lets a read-only identity read but not plan or roster', async () => {
    expect((await apiRequest(app, auditor, 'GET', '/internal-audits')).status).toBe(200);
    expect(
      (await apiRequest(app, auditor, 'GET', '/internal-audits/reports/unlinked-findings')).status,
    ).toBe(200);

    const planned = await apiRequest(app, auditor, 'POST', '/internal-audits', {
      reference: nextAudit(),
      title: 'Auditor should not plan this',
      objective: OBJECTIVE,
      scope: SCOPE,
      criteria: CRITERIA,
      leadAuditorId: FIXTURE.SECURITY.id,
    });
    expect(planned.status).toBe(403);

    const audit = await planAudit();
    const rostered = await apiRequest(
      app,
      auditor,
      'PUT',
      `/internal-audits/${audit.id}/auditors/${FIXTURE.HR.id}`,
      { role: 'auditor' },
    );
    expect(rostered.status).toBe(403);
  });

  it('refuses an identity holding no codes at all', async () => {
    expect((await apiRequest(app, employee, 'GET', '/internal-audits')).status).toBe(403);
  });
});
