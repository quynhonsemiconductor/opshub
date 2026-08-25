/**
 * QMS end to end: the non-conformance register, the CAPA lifecycle, and the gate between them.
 *
 * WHAT THIS EXISTS TO PIN
 * -----------------------
 *   - THE SEVERITIES TABLE COVERS THE ENUM, and its policy is coherent: `requiresCapa` set for the
 *     grades that mean systemic failure, containment windows that shorten as the grade worsens. The
 *     FK guarantees a graded finding has a row; it does NOT guarantee every enum value has one, and
 *     a grade with no row surfaces as a foreign-key 500.
 *   - ANY AUTHENTICATED EMPLOYEE MAY RAISE ONE, and cannot handle it. This file is named by
 *     `@AuthorizedInService` on `POST /nonconformances/report`, so it asserts BOTH directions: an
 *     identity with no permission codes can report, and the same identity is refused at contain,
 *     close and void.
 *   - THE CLOSURE GATE. A `major` finding cannot be closed until a CAPA is verified effective, and
 *     the answer is a coded 412 rather than a silent success. A `minor` one closes on its
 *     containment, because its grade says so — read from the table, not from the code.
 *   - THE ANALYSIS GATE. A CAPA cannot be planned without a root cause, the method behind it, and a
 *     plan.
 *   - SEPARATION OF DUTIES. `capa.verify` is in no role bundle, so `security` is refused (403); and
 *     the CAPA's own owner is refused (412) even holding the permission, in BOTH review directions.
 *   - THE REVIEW CAN FAIL. `ineffective` returns the CAPA to `analysis` and the finding stays
 *     unclosable — the loop that makes §10.2(d) mean something.
 *   - THE REPORTS: a finding past its grade's containment window, and a process area where a finding
 *     arrived AFTER somebody signed off a fix for it.
 *
 * REFERENCES ARE UNIQUE PER RUN — `uq_nc_reference` and `uq_capa_reference` are global and the
 * database is shared with the other suites, so a fixed reference makes a spec that passes once.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d`, `pnpm db:migrate`, `pnpm db:seed`.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nonconformanceSeverityEnum } from '../../db/schema/enums';
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
/** Holds `nonconformance.*` and `capa.manage`, but NOT `capa.verify`. */
let security: Session;
/** Holds `nonconformance.read` only. */
let auditor: Session;
/** Holds the wildcard, so it is the only identity here that can verify a CAPA. */
let admin: Session;
/** Holds no permission codes at all — and must still be able to raise a finding. */
let employee: Session;

const RUN = Date.now().toString(36).toUpperCase().slice(-6);
let seq = 0;
const nextNc = (): string => `E2E-NC-${RUN}-${++seq}`;
const nextCapa = (): string => `E2E-CAPA-${RUN}-${++seq}`;

const DESCRIPTION = 'The release was approved by one person where the procedure requires two.';
const REQUIREMENT = 'SOP-12 section 4 requires two approvals before release.';
const CONTAINMENT = 'We re-ran the approval with two signatories and re-issued the release note.';
const CLOSURE = 'Re-audited the last ten releases; every one carried two recorded approvals.';
const CAUSE = 'The pipeline accepted a single approver because the branch rule was advisory only.';
const PLAN = 'Make the branch rule blocking and add a pipeline gate that fails on one approval.';
const EVIDENCE = 'Re-audited ten releases after the change; the gate blocked two single approvals.';
const FAILED = 'The gate was bypassed twice using an administrative override nobody had removed.';

const DAY_MS = 86_400_000;
const daysAgo = (days: number): string => new Date(Date.now() - days * DAY_MS).toISOString();

interface NcRow {
  id: string;
  reference: string;
  severity: string;
  status: string;
  processArea: string;
  ownerId: string;
  /** Resolved server-side on the READ paths. Null only when the employee row is gone. */
  ownerName: string | null;
  raisedBy: string;
  detectedAt: string;
  containedAt: string | null;
  containmentAction: string | null;
  closedAt: string | null;
  closedBy: string | null;
  voidReason: string | null;
}
interface NcListRow extends NcRow {
  severityRank: number;
  requiresCapa: boolean;
  containmentDueDays: number;
  capaCount: number;
  verifiedCapaCount: number;
  containmentDueOn: string | null;
}
interface GradeRow {
  code: string;
  rank: number;
  requiresCapa: boolean;
  containmentDueDays: number;
}
interface CapaRow {
  id: string;
  reference: string;
  nonconformanceId: string;
  status: string;
  ownerId: string;
  /** Resolved server-side on the READ paths. Null only when the employee row is gone. */
  ownerName: string | null;
  rootCause: string | null;
  rootCauseMethod: string | null;
  verifiedBy: string | null;
  effectivenessEvidence: string | null;
  outcomeNote: string | null;
}
interface OverdueRow {
  id: string;
  reference: string;
  dueOn: string;
  daysOverdue: number;
}
interface RecurrenceRow {
  processArea: string;
  latestReference: string;
  latestDetectedAt: string;
  earlierCapaVerifiedAt: string;
}

/**
 * Raise a finding. OVERRIDES FIRST, session second — see the information-asset spec for why.
 *
 * Note the register reads below match on the EXACT reference rather than taking `[0]` off a search:
 * `search` is a substring match and these references are sequential, so `E2E-NC-X-1` also matches
 * `E2E-NC-X-10`. That bit the internal-audit spec for real once a run passed ten findings.
 */
async function raise(
  over: Record<string, unknown> = {},
  session: Session = security,
): Promise<NcRow> {
  const res = await apiRequest(app, session, 'POST', '/nonconformances/report', {
    reference: nextNc(),
    title: 'Two approvals required, one recorded',
    description: DESCRIPTION,
    requirement: REQUIREMENT,
    source: 'internal_audit',
    severity: 'major',
    processArea: `release-management-${RUN}`,
    ownerId: FIXTURE.SECURITY.id,
    ...over,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return unwrap<NcRow>(res.body);
}

/**
 * Raise a finding and contain it — the only state closure is legal from.
 *
 * `open → closed` is refused by the state machine AND by `ck_nc_contained_states`: ISO 9001 §10.2(a)
 * requires reacting to the nonconformity, so a finding cannot go from "found" to "closed" with
 * nothing recorded in between. The first draft of the service allowed it and the database refused.
 */
async function raiseAndContain(over: Record<string, unknown> = {}): Promise<NcRow> {
  const finding = await raise(over);
  const res = await apiRequest(app, security, 'POST', `/nonconformances/${finding.id}/contain`, {
    containmentAction: CONTAINMENT,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return finding;
}

/** Open a CAPA owned by SECURITY, so ADMIN can verify it without hitting self-verification. */
async function openCapa(ncId: string, over: Record<string, unknown> = {}): Promise<CapaRow> {
  const res = await apiRequest(app, security, 'POST', `/capas/for/${ncId}`, {
    reference: nextCapa(),
    ownerId: FIXTURE.SECURITY.id,
    ...over,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return unwrap<CapaRow>(res.body);
}

/** Drive a CAPA all the way to `verified`, which is what unlocks closing a major finding. */
async function verifiedCapa(ncId: string): Promise<CapaRow> {
  const capa = await openCapa(ncId);
  for (const [url, payload] of [
    [
      `/capas/${capa.id}/analysis`,
      { rootCause: CAUSE, rootCauseMethod: 'five_whys', actionPlan: PLAN },
    ],
    [`/capas/${capa.id}/plan`, undefined],
    [`/capas/${capa.id}/start`, undefined],
    [`/capas/${capa.id}/implemented`, {}],
  ] as const) {
    const res = await apiRequest(app, security, 'POST', url, payload);
    expect(res.status, `${url}: ${JSON.stringify(res.body)}`).toBe(200);
  }
  // ADMIN verifies: SECURITY owns it and lacks `capa.verify` anyway.
  const verified = await apiRequest(app, admin, 'POST', `/capas/${capa.id}/verify`, {
    effectivenessEvidence: EVIDENCE,
  });
  expect(verified.status, JSON.stringify(verified.body)).toBe(200);
  return unwrap<CapaRow>(verified.body);
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

describe('severity grades', () => {
  it('has a row for every value the enum allows', async () => {
    const res = await apiRequest(app, security, 'GET', '/nonconformances/severities');
    expect(res.status).toBe(200);
    const grades = unwrap<GradeRow[]>(res.body);
    expect(new Set(grades.map((g) => g.code))).toEqual(
      new Set(nonconformanceSeverityEnum.enumValues),
    );
  });

  it('ranks them uniquely and carries a coherent policy', async () => {
    const grades = unwrap<GradeRow[]>(
      (await apiRequest(app, security, 'GET', '/nonconformances/severities')).body,
    );
    const ranks = grades.map((g) => g.rank);
    expect(new Set(ranks).size).toBe(ranks.length);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);

    const byCode = Object.fromEntries(grades.map((g) => [g.code, g]));
    // The grades that mean systemic failure demand a corrective action; the others do not.
    expect(byCode.major.requiresCapa).toBe(true);
    expect(byCode.critical.requiresCapa).toBe(true);
    expect(byCode.minor.requiresCapa).toBe(false);
    expect(byCode.observation.requiresCapa).toBe(false);
    // Worse grade, shorter fuse.
    expect(byCode.critical.containmentDueDays).toBeLessThan(byCode.major.containmentDueDays);
    expect(byCode.major.containmentDueDays).toBeLessThan(byCode.minor.containmentDueDays);
  });
});

describe('raising is open to everybody, handling is not', () => {
  it('lets an identity with no permission codes raise a finding', async () => {
    // The direction `@AuthorizedInService` on the route promises.
    const finding = await raise({}, employee);
    expect(finding.status).toBe('open');
    // And the raiser comes from the token, not the payload.
    expect(finding.raisedBy).toBe(FIXTURE.NO_PERMISSIONS.id);
  });

  it('refuses that same identity every handling route', async () => {
    // The other direction, which is what makes the in-service declaration honest.
    const finding = await raise();
    for (const [url, payload] of [
      [`/nonconformances/${finding.id}/contain`, { containmentAction: CONTAINMENT }],
      [`/nonconformances/${finding.id}/close`, { closureNote: CLOSURE }],
      [`/nonconformances/${finding.id}/void`, { reason: CLOSURE }],
    ] as const) {
      const res = await apiRequest(app, employee, 'POST', url, payload);
      expect(res.status, url).toBe(403);
    }
    // Reading the register is not open either.
    expect((await apiRequest(app, employee, 'GET', '/nonconformances')).status).toBe(403);
  });

  it('refuses a duplicate reference', async () => {
    const finding = await raise();
    const res = await apiRequest(app, security, 'POST', '/nonconformances/report', {
      reference: finding.reference,
      title: 'A different finding entirely',
      description: DESCRIPTION,
      requirement: REQUIREMENT,
      source: 'other',
      severity: 'minor',
      processArea: 'somewhere else',
      ownerId: FIXTURE.SECURITY.id,
    });
    expect(res.status).toBe(409);
    expect(errorCode(res.body)).toBe('CONFLICT');
  });

  it('refuses a detection date in the future', async () => {
    const res = await apiRequest(app, security, 'POST', '/nonconformances/report', {
      reference: nextNc(),
      title: 'Detected tomorrow somehow',
      description: DESCRIPTION,
      requirement: REQUIREMENT,
      source: 'other',
      severity: 'minor',
      processArea: 'time travel',
      ownerId: FIXTURE.SECURITY.id,
      detectedAt: new Date(Date.now() + DAY_MS).toISOString(),
    });
    expect(res.status).toBe(412);
    expect(errorCode(res.body)).toBe('NONCONFORMANCE_NOT_IN_STATE');
  });
});

describe('naming the owner rather than showing a uuid', () => {
  /*
   * WHY THIS IS ASSERTED AT ALL. The register's Owner field rendered `ownerId`, so the one question it
   * exists to answer — who is accountable for this process failure — came back as thirty-six characters
   * that identify nobody, and worse than nobody on uuid v7, where findings raised the same afternoon
   * share a time prefix and look alike. The names have to come from the API: `GET /v1/employees` needs
   * `employee.read`, which `nonconformance.read` does not imply, so a caller who may read the register
   * and not the directory would get a 403 and a dash — and a page of rows cannot cost a request per row.
   *
   * The CREATE response is deliberately left unasserted here. It carries no name, because the SPA
   * discards it and refetches, so resolving there would be a directory query nobody reads.
   */
  it('names the finding owner in the register and in the single finding', async () => {
    const finding = await raise();

    const list = await apiRequest(
      app,
      security,
      'GET',
      `/nonconformances?search=${finding.reference}&limit=100`,
    );
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    // Matched on the EXACT reference: `search` is a substring match and these references are
    // sequential, so taking `[0]` reads a different finding once a run passes ten.
    const row = unwrap<NcListRow[]>(list.body).find((r) => r.reference === finding.reference);
    expect(row, `no register row for ${finding.reference}`).toBeDefined();
    expect(
      row!.ownerName,
      `finding ${row!.reference} came back with owner ${row!.ownerId} and no name`,
    ).toBeTruthy();

    // The single-finding read is a SEPARATE service method from the list — `getRowById`, not `list` —
    // so it needs its own assertion. One of the two silently showing a uuid is the exact state this
    // change was made to end, and nothing else in the suite would notice.
    const one = await apiRequest(app, security, 'GET', `/nonconformances/${finding.id}`);
    expect(one.status).toBe(200);
    expect(unwrap<NcListRow>(one.body).ownerName).toBe(row!.ownerName);
  });

  it('names the CAPA owner in the queue, under its finding, and on its own', async () => {
    const finding = await raise();
    const capa = await openCapa(finding.id);

    /*
     * THREE read paths, three service methods. The queue (`list`) and the finding's drawer
     * (`listForNonconformance`) render the SAME card component, so one of them omitting the field
     * would look like a card stuck loading rather than like a bug; and `GET /capas/:id` resolves
     * through `getWithOwner`, which exists precisely because `getById` is the guard eight transitions
     * share and none of them render an owner.
     */
    const queue = await apiRequest(app, security, 'GET', `/capas?nonconformanceId=${finding.id}`);
    expect(queue.status, JSON.stringify(queue.body)).toBe(200);
    const queued = unwrap<CapaRow[]>(queue.body).find((c) => c.id === capa.id);
    expect(queued, `CAPA ${capa.reference} is not in the queue`).toBeDefined();
    expect(
      queued!.ownerName,
      `CAPA ${capa.reference} came back with owner ${capa.ownerId} and no name`,
    ).toBeTruthy();

    const underFinding = await apiRequest(
      app,
      security,
      'GET',
      `/nonconformances/${finding.id}/capas`,
    );
    expect(underFinding.status).toBe(200);
    const nested = unwrap<CapaRow[]>(underFinding.body).find((c) => c.id === capa.id)!;
    expect(nested.ownerName).toBe(queued!.ownerName);

    const one = await apiRequest(app, security, 'GET', `/capas/${capa.id}`);
    expect(one.status).toBe(200);
    expect(unwrap<CapaRow>(one.body).ownerName).toBe(queued!.ownerName);
  });
});

describe('the closure gate', () => {
  it('refuses to close a major finding with no verified CAPA', async () => {
    const finding = await raiseAndContain({ severity: 'major' });
    const res = await apiRequest(app, security, 'POST', `/nonconformances/${finding.id}/close`, {
      closureNote: CLOSURE,
    });
    expect(res.status).toBe(412);
    expect(errorCode(res.body)).toBe('NONCONFORMANCE_CAPA_REQUIRED');
  });

  it('refuses to close a finding that was never contained, whatever its grade', async () => {
    // ISO 9001 §10.2(a): react to the nonconformity. Asserted on a grade that needs NO CAPA, so the
    // only thing that can refuse it is the containment requirement.
    const finding = await raise({ severity: 'minor' });
    const res = await apiRequest(app, security, 'POST', `/nonconformances/${finding.id}/close`, {
      closureNote: CLOSURE,
    });
    expect(res.status).toBe(412);
    expect(errorCode(res.body)).toBe('NONCONFORMANCE_NOT_IN_STATE');
  });

  it('still refuses while a CAPA exists but is not verified', async () => {
    // Opening one is not doing one. This is the case a count of CAPAs would get wrong.
    const finding = await raiseAndContain({ severity: 'major' });
    await openCapa(finding.id);
    const res = await apiRequest(app, security, 'POST', `/nonconformances/${finding.id}/close`, {
      closureNote: CLOSURE,
    });
    expect(res.status).toBe(412);
    expect(errorCode(res.body)).toBe('NONCONFORMANCE_CAPA_REQUIRED');
  });

  it('reads back the gate on the DETAIL endpoint, not only in the list', async () => {
    /*
     * A detail view has to answer "may this close", and that answer is `requiresCapa` against
     * `verifiedCapaCount` — both computed, neither on the bare row. `GET :id` used to return the base
     * shape, so the drawer read "undefined of undefined CAPA(s) verified" and offered a closure the API
     * would have refused. Pinned here because the two endpoints returning DIFFERENT shapes for the same
     * finding is the kind of drift nothing else notices.
     */
    const finding = await raiseAndContain({ severity: 'major' });
    await openCapa(finding.id);

    const res = await apiRequest(app, security, 'GET', `/nonconformances/${finding.id}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // `NcListRow`, from the detail endpoint: that is the point of the case.
    const row = unwrap<NcListRow>(res.body);
    expect(row.requiresCapa).toBe(true);
    expect(row.capaCount).toBe(1);
    expect(row.verifiedCapaCount).toBe(0);
    expect(row.containmentDueDays).toBeGreaterThan(0);
    // Contained, so its deadline is gone: a met deadline is not a deadline.
    expect(row.containmentDueOn).toBeNull();
  });

  it('closes once a CAPA is verified effective', async () => {
    const finding = await raiseAndContain({ severity: 'major' });
    await verifiedCapa(finding.id);
    const res = await apiRequest(app, security, 'POST', `/nonconformances/${finding.id}/close`, {
      closureNote: CLOSURE,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const closed = unwrap<NcRow>(res.body);
    expect(closed.status).toBe('closed');
    expect(closed.closedBy).toBe(FIXTURE.SECURITY.id);
  });

  it('closes a minor finding on its containment, because its grade says so', async () => {
    const finding = await raise({ severity: 'minor' });
    const contained = await apiRequest(
      app,
      security,
      'POST',
      `/nonconformances/${finding.id}/contain`,
      {
        containmentAction: CONTAINMENT,
      },
    );
    expect(contained.status, JSON.stringify(contained.body)).toBe(200);
    const res = await apiRequest(app, security, 'POST', `/nonconformances/${finding.id}/close`, {
      closureNote: CLOSURE,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('applies the gate to the CURRENT grade, so re-grading tightens it', async () => {
    // Re-grading is ordinary work on better information, and the gate reads the new grade — which is
    // what makes re-grading meaningful rather than cosmetic.
    const finding = await raiseAndContain({ severity: 'minor' });
    const upgraded = await apiRequest(app, security, 'PATCH', `/nonconformances/${finding.id}`, {
      severity: 'critical',
    });
    expect(upgraded.status, JSON.stringify(upgraded.body)).toBe(200);

    const res = await apiRequest(app, security, 'POST', `/nonconformances/${finding.id}/close`, {
      closureNote: CLOSURE,
    });
    expect(res.status).toBe(412);
    expect(errorCode(res.body)).toBe('NONCONFORMANCE_CAPA_REQUIRED');
  });

  it('accepts nothing further once closed', async () => {
    const finding = await raiseAndContain({ severity: 'minor' });
    await apiRequest(app, security, 'POST', `/nonconformances/${finding.id}/close`, {
      closureNote: CLOSURE,
    });
    const patched = await apiRequest(app, security, 'PATCH', `/nonconformances/${finding.id}`, {
      processArea: 'renamed after closure',
    });
    expect(patched.status).toBe(412);
    expect(errorCode(patched.body)).toBe('NONCONFORMANCE_SETTLED');

    const again = await apiRequest(app, security, 'POST', `/nonconformances/${finding.id}/close`, {
      closureNote: CLOSURE,
    });
    expect(again.status).toBe(412);
    expect(errorCode(again.body)).toBe('NONCONFORMANCE_NOT_IN_STATE');
  });
});

describe('voiding', () => {
  it('records a finding raised in error rather than deleting it', async () => {
    const finding = await raise();
    const res = await apiRequest(app, security, 'POST', `/nonconformances/${finding.id}/void`, {
      reason: 'Raised against the wrong procedure; SOP-12 does not apply to this release train.',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(unwrap<NcRow>(res.body).status).toBe('void');
    // Still readable — an auditor may ask about it.
    expect((await apiRequest(app, security, 'GET', `/nonconformances/${finding.id}`)).status).toBe(
      200,
    );
  });

  it('refuses to void a finding that has been contained', async () => {
    // Containing something is saying it was real.
    const finding = await raise();
    await apiRequest(app, security, 'POST', `/nonconformances/${finding.id}/contain`, {
      containmentAction: CONTAINMENT,
    });
    const res = await apiRequest(app, security, 'POST', `/nonconformances/${finding.id}/void`, {
      reason: 'Changed our mind about whether this was real at all.',
    });
    expect(res.status).toBe(412);
    expect(errorCode(res.body)).toBe('NONCONFORMANCE_NOT_IN_STATE');
  });
});

describe('the CAPA lifecycle', () => {
  it('refuses to plan without the analysis, naming what is missing', async () => {
    const finding = await raise();
    const capa = await openCapa(finding.id);
    const res = await apiRequest(app, security, 'POST', `/capas/${capa.id}/plan`);
    expect(res.status).toBe(412);
    expect(errorCode(res.body)).toBe('CAPA_ANALYSIS_INCOMPLETE');
  });

  it('walks analysis to implemented', async () => {
    const finding = await raise();
    const capa = await openCapa(finding.id);
    const analysed = await apiRequest(app, security, 'POST', `/capas/${capa.id}/analysis`, {
      rootCause: CAUSE,
      rootCauseMethod: 'five_whys',
      actionPlan: PLAN,
    });
    expect(analysed.status, JSON.stringify(analysed.body)).toBe(200);
    expect(unwrap<CapaRow>(analysed.body).rootCauseMethod).toBe('five_whys');

    for (const step of ['plan', 'start'] as const) {
      const res = await apiRequest(app, security, 'POST', `/capas/${capa.id}/${step}`);
      expect(res.status, step).toBe(200);
    }
    const implemented = await apiRequest(
      app,
      security,
      'POST',
      `/capas/${capa.id}/implemented`,
      {},
    );
    expect(implemented.status).toBe(200);
    expect(unwrap<CapaRow>(implemented.body).status).toBe('implemented');
  });

  it('refuses to skip a state', async () => {
    const finding = await raise();
    const capa = await openCapa(finding.id);
    const res = await apiRequest(app, security, 'POST', `/capas/${capa.id}/implemented`, {});
    expect(res.status).toBe(412);
    expect(errorCode(res.body)).toBe('CAPA_NOT_IN_STATE');
  });

  it('refuses to open one against a settled finding', async () => {
    const finding = await raiseAndContain({ severity: 'minor' });
    await apiRequest(app, security, 'POST', `/nonconformances/${finding.id}/close`, {
      closureNote: CLOSURE,
    });
    const res = await apiRequest(app, security, 'POST', `/capas/for/${finding.id}`, {
      reference: nextCapa(),
      ownerId: FIXTURE.SECURITY.id,
    });
    expect(res.status).toBe(412);
    expect(errorCode(res.body)).toBe('NONCONFORMANCE_SETTLED');
  });

  it('lists a finding CAPAs under the finding, on the register read permission', async () => {
    const finding = await raise();
    const capa = await openCapa(finding.id);
    const res = await apiRequest(app, auditor, 'GET', `/nonconformances/${finding.id}/capas`);
    expect(res.status).toBe(200);
    expect(unwrap<CapaRow[]>(res.body).map((c) => c.id)).toContain(capa.id);
  });
});

describe('the effectiveness review', () => {
  async function implementedCapa(): Promise<{ finding: NcRow; capa: CapaRow }> {
    // Contained, so the tests below can go on to prove the CAPA gate is what refuses the closure
    // rather than the containment requirement.
    const finding = await raiseAndContain();
    const capa = await openCapa(finding.id);
    await apiRequest(app, security, 'POST', `/capas/${capa.id}/analysis`, {
      rootCause: CAUSE,
      rootCauseMethod: 'five_whys',
      actionPlan: PLAN,
    });
    await apiRequest(app, security, 'POST', `/capas/${capa.id}/plan`);
    await apiRequest(app, security, 'POST', `/capas/${capa.id}/start`);
    await apiRequest(app, security, 'POST', `/capas/${capa.id}/implemented`, {});
    return { finding, capa };
  }

  it('refuses an identity that holds capa.manage but not capa.verify', async () => {
    // `capa.verify` is in no default role bundle, like `risk.accept` and `vendor.approve`.
    const { capa } = await implementedCapa();
    const res = await apiRequest(app, security, 'POST', `/capas/${capa.id}/verify`, {
      effectivenessEvidence: EVIDENCE,
    });
    expect(res.status).toBe(403);
  });

  it('refuses the CAPA owner even with the permission', async () => {
    // The permission says who MAY sign; this rule is what makes the signature a review. ADMIN holds
    // the wildcard AND owns this CAPA, so only the separation rule can refuse it.
    const finding = await raise();
    const capa = await openCapa(finding.id, { ownerId: FIXTURE.ADMIN.id });
    await apiRequest(app, security, 'POST', `/capas/${capa.id}/analysis`, {
      rootCause: CAUSE,
      rootCauseMethod: 'five_whys',
      actionPlan: PLAN,
    });
    await apiRequest(app, security, 'POST', `/capas/${capa.id}/plan`);
    await apiRequest(app, security, 'POST', `/capas/${capa.id}/start`);
    await apiRequest(app, security, 'POST', `/capas/${capa.id}/implemented`, {});

    const res = await apiRequest(app, admin, 'POST', `/capas/${capa.id}/verify`, {
      effectivenessEvidence: EVIDENCE,
    });
    expect(res.status).toBe(412);
    expect(errorCode(res.body)).toBe('CAPA_SELF_VERIFICATION');
  });

  it('records the verifier and the evidence', async () => {
    const { capa } = await implementedCapa();
    const res = await apiRequest(app, admin, 'POST', `/capas/${capa.id}/verify`, {
      effectivenessEvidence: EVIDENCE,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const verified = unwrap<CapaRow>(res.body);
    expect(verified.status).toBe('verified');
    expect(verified.verifiedBy).toBe(FIXTURE.ADMIN.id);
    expect(verified.effectivenessEvidence).toBe(EVIDENCE);
  });

  it('can FAIL, returning the CAPA to analysis and leaving the finding unclosable', async () => {
    // The loop that makes §10.2(d) mean something.
    const { finding, capa } = await implementedCapa();
    const failed = await apiRequest(app, admin, 'POST', `/capas/${capa.id}/ineffective`, {
      reason: FAILED,
    });
    expect(failed.status, JSON.stringify(failed.body)).toBe(200);
    expect(unwrap<CapaRow>(failed.body).status).toBe('ineffective');

    const blocked = await apiRequest(
      app,
      security,
      'POST',
      `/nonconformances/${finding.id}/close`,
      {
        closureNote: CLOSURE,
      },
    );
    expect(blocked.status).toBe(412);
    expect(errorCode(blocked.body)).toBe('NONCONFORMANCE_CAPA_REQUIRED');

    // A second attempt records a different cause without touching the first attempt's evidence.
    const reopened = await apiRequest(app, security, 'POST', `/capas/${capa.id}/reopen-analysis`);
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
    expect(unwrap<CapaRow>(reopened.body).status).toBe('analysis');

    const reanalysed = await apiRequest(app, security, 'POST', `/capas/${capa.id}/analysis`, {
      rootCause: 'The administrative override was never removed after the migration.',
      rootCauseMethod: 'fishbone',
      actionPlan: 'Remove the override and add a weekly check that no override exists.',
    });
    expect(reanalysed.status).toBe(200);
    expect(unwrap<CapaRow>(reanalysed.body).rootCauseMethod).toBe('fishbone');
  });

  it('refuses to verify a CAPA twice', async () => {
    const { capa } = await implementedCapa();
    await apiRequest(app, admin, 'POST', `/capas/${capa.id}/verify`, {
      effectivenessEvidence: EVIDENCE,
    });
    const again = await apiRequest(app, admin, 'POST', `/capas/${capa.id}/verify`, {
      effectivenessEvidence: EVIDENCE,
    });
    expect(again.status).toBe(412);
    expect(errorCode(again.body)).toBe('CAPA_NOT_IN_STATE');
  });

  it('does not let a cancelled CAPA close a major finding', async () => {
    const { finding, capa } = await implementedCapa();
    const cancelled = await apiRequest(app, security, 'POST', `/capas/${capa.id}/cancel`, {
      reason: 'Superseded by a wider change to the release process.',
    });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);

    const res = await apiRequest(app, security, 'POST', `/nonconformances/${finding.id}/close`, {
      closureNote: CLOSURE,
    });
    expect(res.status).toBe(412);
    expect(errorCode(res.body)).toBe('NONCONFORMANCE_CAPA_REQUIRED');
  });
});

describe('reports', () => {
  it('surfaces a finding past its grade containment window', async () => {
    // `critical` allows one day. Detected three days ago, so it is two days over.
    const finding = await raise({ severity: 'critical', detectedAt: daysAgo(3) });
    const rows = unwrap<OverdueRow[]>(
      (await apiRequest(app, security, 'GET', '/nonconformances/reports/containment-overdue')).body,
    );
    const mine = rows.find((r) => r.id === finding.id);
    expect(mine, 'a critical finding detected 3 days ago must be overdue').toBeDefined();
    expect(mine!.daysOverdue).toBeGreaterThanOrEqual(1);
  });

  it('drops it once contained', async () => {
    const finding = await raise({ severity: 'critical', detectedAt: daysAgo(3) });
    await apiRequest(app, security, 'POST', `/nonconformances/${finding.id}/contain`, {
      containmentAction: CONTAINMENT,
    });
    const rows = unwrap<OverdueRow[]>(
      (await apiRequest(app, security, 'GET', '/nonconformances/reports/containment-overdue')).body,
    );
    expect(rows.map((r) => r.id)).not.toContain(finding.id);
  });

  it('leaves a finding inside its window alone', async () => {
    // `minor` allows fourteen days.
    const finding = await raise({ severity: 'minor', detectedAt: daysAgo(2) });
    const rows = unwrap<OverdueRow[]>(
      (await apiRequest(app, security, 'GET', '/nonconformances/reports/containment-overdue')).body,
    );
    expect(rows.map((r) => r.id)).not.toContain(finding.id);
  });

  it('shows the containment deadline on the register row, and clears it once met', async () => {
    const finding = await raise({ severity: 'major', detectedAt: daysAgo(1) });
    const before = unwrap<NcListRow[]>(
      (
        await apiRequest(
          app,
          security,
          'GET',
          `/nonconformances?search=${finding.reference}&limit=100`,
        )
      ).body,
    ).find((r) => r.reference === finding.reference)!;
    expect(before.containmentDueDays).toBe(7);
    expect(before.containmentDueOn).not.toBeNull();

    await apiRequest(app, security, 'POST', `/nonconformances/${finding.id}/contain`, {
      containmentAction: CONTAINMENT,
    });
    const after = unwrap<NcListRow[]>(
      (
        await apiRequest(
          app,
          security,
          'GET',
          `/nonconformances?search=${finding.reference}&limit=100`,
        )
      ).body,
    ).find((r) => r.reference === finding.reference)!;
    // A met deadline is not a deadline — leaving it populated is how a screen shows a red date next
    // to a finished job.
    expect(after.containmentDueOn).toBeNull();
  });

  it('flags a process area where a finding arrived after a fix was signed off', async () => {
    // The §10.2(d) signal. A unique area per run, so the assertion is about this run's rows only.
    const area = `recurrence-${RUN}`;
    const first = await raiseAndContain({ processArea: area, severity: 'major' });
    await verifiedCapa(first.id);
    // Raised now, which is after the verification a moment ago.
    const second = await raise({ processArea: area, severity: 'major' });

    const rows = unwrap<RecurrenceRow[]>(
      (await apiRequest(app, security, 'GET', '/nonconformances/reports/recurrence')).body,
    );
    const mine = rows.find((r) => r.processArea === area);
    expect(mine, 'an area with a verified CAPA and a later finding must be flagged').toBeDefined();
    expect(mine!.latestReference).toBe(second.reference);
    expect(new Date(mine!.latestDetectedAt).getTime()).toBeGreaterThan(
      new Date(mine!.earlierCapaVerifiedAt).getTime(),
    );
  });

  it('does not flag an area whose only findings predate the fix', async () => {
    const area = `no-recurrence-${RUN}`;
    const only = await raiseAndContain({ processArea: area, severity: 'major' });
    await verifiedCapa(only.id);

    const rows = unwrap<RecurrenceRow[]>(
      (await apiRequest(app, security, 'GET', '/nonconformances/reports/recurrence')).body,
    );
    expect(rows.map((r) => r.processArea)).not.toContain(area);
  });
});

describe('listing and permissions', () => {
  it('lists worst grade first', async () => {
    const res = await apiRequest(app, security, 'GET', '/nonconformances?limit=100');
    expect(res.status).toBe(200);
    const ranks = unwrap<NcListRow[]>(res.body).map((r) => r.severityRank);
    expect([...ranks].sort((a, b) => b - a)).toEqual(ranks);
  });

  it('counts CAPAs and verified CAPAs on the register row', async () => {
    const finding = await raise({ severity: 'major' });
    await verifiedCapa(finding.id);
    await openCapa(finding.id);
    const row = unwrap<NcListRow[]>(
      (
        await apiRequest(
          app,
          security,
          'GET',
          `/nonconformances?search=${finding.reference}&limit=100`,
        )
      ).body,
    ).find((r) => r.reference === finding.reference)!;
    expect(row.capaCount).toBe(2);
    expect(row.verifiedCapaCount).toBe(1);
  });

  it('filters to the grades that require a corrective action', async () => {
    const major = await raise({ severity: 'major' });
    const minor = await raise({ severity: 'minor' });
    const rows = unwrap<NcListRow[]>(
      (await apiRequest(app, security, 'GET', '/nonconformances?capaRequiredOnly=true&limit=100'))
        .body,
    );
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(major.id);
    expect(ids).not.toContain(minor.id);
    expect(rows.every((r) => r.requiresCapa)).toBe(true);
  });

  it('lets a read-only identity read but not handle or open CAPAs', async () => {
    expect((await apiRequest(app, auditor, 'GET', '/nonconformances')).status).toBe(200);
    expect((await apiRequest(app, auditor, 'GET', '/capas')).status).toBe(200);
    expect(
      (await apiRequest(app, auditor, 'GET', '/nonconformances/reports/recurrence')).status,
    ).toBe(200);

    const finding = await raise();
    const contained = await apiRequest(
      app,
      auditor,
      'POST',
      `/nonconformances/${finding.id}/contain`,
      {
        containmentAction: CONTAINMENT,
      },
    );
    expect(contained.status).toBe(403);

    const opened = await apiRequest(app, auditor, 'POST', `/capas/for/${finding.id}`, {
      reference: nextCapa(),
      ownerId: FIXTURE.SECURITY.id,
    });
    expect(opened.status).toBe(403);
  });
});
