/**
 * ISMS vendor risk end to end: the register, the go-live gate, the cadence, and the spend report.
 *
 * WHAT THIS EXISTS TO PIN
 * -----------------------
 *   - THE TIERS TABLE COVERS THE ENUM, and carries a positive interval for every tier. `criticality`
 *     is an FK to `isms.vendor_criticality_levels`, which guarantees a classified vendor has a tier —
 *     but NOT that every enum value has a tier row. A tier with no row is unusable and surfaces as a
 *     foreign-key 500. No constraint can express that, so this is the test that does.
 *   - GOING LIVE REQUIRES A CURRENT PASSING ASSESSMENT. Never assessed, or last assessment failed,
 *     and the answer is a coded 412 — the rule the module exists for, and one no CHECK can hold
 *     because it is about the latest row of another table.
 *   - APPROVAL IS ITS OWN PERMISSION, in both the ways that could go wrong: `security` holds
 *     `vendor.manage` and is refused at `activate` (403), while `admin` with the wildcard succeeds.
 *     Suspension stays with `manage`, because stopping is never the risky direction.
 *   - AN ACTIVE PROCESSOR HAS AN AGREEMENT (GDPR Article 28(3)) — refused on the way live, and
 *     refused when somebody tries to clear the agreement from a live processor.
 *   - THE CADENCE IS COMPUTED, NOT SUPPLIED. Recording an assessment moves `reviewDueOn` to
 *     `assessedAt + the tier's interval`, and the exact date is asserted rather than "some date".
 *   - TERMINATION IS TERMINAL and the record accepts nothing further.
 *   - THE REPORTS ARE THE POINT: a stale assessment surfaces as overdue with the shortfall counted,
 *     a fresh one does not, a prospective supplier is not a gap in anything, a critical supplier
 *     drops off the no-risk report once a risk is linked, and a licence drops off the
 *     unassessed-spend report once its vendor is linked AND assessed.
 *
 *     NOT tested, because the API cannot produce it: a live supplier with no assessment at all.
 *     Going live requires one, so `review_due_on` is always set by then. The report still handles a
 *     null — see the repository — but that branch guards imported rows rather than anything reachable
 *     from here, and pretending otherwise with a test that fakes the state would be worse than
 *     saying so.
 *
 * REFERENCES ARE UNIQUE PER RUN — `uq_vendor_reference` is global and the database is shared with the
 * other suites, so a fixed reference makes a spec that passes once.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d`, `pnpm db:migrate`, `pnpm db:seed`.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { vendorCriticalityEnum } from '../../db/schema/enums';
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
/** Holds `vendor.read` + `vendor.manage`, but NOT `vendor.approve`. */
let security: Session;
/** Holds `vendor.read` only. */
let auditor: Session;
/** Holds the wildcard, so it is the only identity here that can approve a supplier. */
let admin: Session;
/** Holds no permission codes at all. */
let employee: Session;

const RUN = Date.now().toString(36).toUpperCase().slice(-6);
let seq = 0;
const nextRef = (): string => `E2E-VEN-${RUN}-${++seq}`;

const SCOPE = 'Reviewed their SOC 2 Type II report and completed the security questionnaire.';
const WHY = 'They failed to remediate the findings raised at the last assessment.';
const FINDINGS = 'Two internet-facing hosts were unpatched for more than 90 days.';
const CONDITIONS = 'Enable MFA for all administrative access by 30 June.';

interface VendorRow {
  id: string;
  reference: string;
  name: string;
  criticality: string;
  status: string;
  ownerId: string;
  ownerName: string | null;
  dataProcessor: boolean;
  dataProcessingAgreementId: string | null;
  contractStartsOn: string | null;
  contractEndsOn: string | null;
  reviewDueOn: string | null;
  terminatedAt: string | null;
  terminationReason: string | null;
}
interface VendorListRow extends VendorRow {
  criticalityRank: number;
  reviewIntervalMonths: number;
  requiresIndependentEvidence: boolean;
  lastAssessedAt: string | null;
  lastOutcome: string | null;
  riskCount: number;
}
interface LevelRow {
  code: string;
  rank: number;
  label: string;
  reviewIntervalMonths: number;
  requiresIndependentEvidence: boolean;
}
interface AssessmentRow {
  id: string;
  outcome: string;
  scope: string;
  findings: string | null;
  conditions: string | null;
  assessedAt: string;
  assessedBy: string;
}
interface GapRow {
  id: string;
  reference: string;
  criticality: string;
  lastAssessedAt: string | null;
  dueOn: string | null;
  daysOverdue: number | null;
}
interface SpendRow {
  licenseId: string;
  licenseName: string;
  vendorText: string;
  vendorId: string | null;
}

/**
 * Register a vendor.
 *
 * OVERRIDES FIRST, session second — the same signature discipline as the information-asset spec: the
 * other order silently turns an overrides object into the session and produces a 401 that reads as an
 * auth bug rather than a typo.
 */
async function register(
  over: Record<string, unknown> = {},
  session: Session = security,
): Promise<VendorRow> {
  const res = await apiRequest(app, session, 'POST', '/vendors', {
    reference: nextRef(),
    name: 'Acme Payroll',
    services: 'Runs monthly payroll and holds salary and bank details for all staff.',
    criticality: 'critical',
    ownerId: FIXTURE.SECURITY.id,
    ...over,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return unwrap<VendorRow>(res.body);
}

async function assess(
  vendorId: string,
  over: Record<string, unknown> = {},
): Promise<AssessmentRow> {
  const res = await apiRequest(app, security, 'POST', `/vendors/${vendorId}/assessments`, {
    outcome: 'pass',
    scope: SCOPE,
    ...over,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return unwrap<AssessmentRow>(res.body);
}

/** A registered, assessed, live vendor — the state most tests need as a starting point. */
async function liveVendor(over: Record<string, unknown> = {}): Promise<VendorRow> {
  const vendor = await register(over);
  await assess(vendor.id);
  const activated = await apiRequest(app, admin, 'POST', `/vendors/${vendor.id}/activate`);
  expect(activated.status, JSON.stringify(activated.body)).toBe(200);
  return unwrap<VendorRow>(activated.body);
}

/** A risk to link, borrowed from the register the vendor module joins to. */
async function createRisk(): Promise<string> {
  const res = await apiRequest(app, security, 'POST', '/risks', {
    reference: `E2E-VRSK-${RUN}-${++seq}`,
    title: 'Supplier outage stops payroll',
    description: 'A prolonged outage at the payroll provider would delay salary payments.',
    category: 'supplier',
    ownerId: FIXTURE.SECURITY.id,
    inherent: { likelihood: 3, impact: 4 },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return unwrap<{ id: string }>(res.body).id;
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

describe('criticality tiers', () => {
  it('has a tier row for every value the enum allows', async () => {
    // The FK guarantees a vendor has a tier; it does NOT guarantee the reverse. A tier in the enum
    // with no row here cannot be used, and the failure would appear as a foreign-key 500.
    const res = await apiRequest(app, security, 'GET', '/vendors/criticality-levels');
    expect(res.status).toBe(200);
    const levels = unwrap<LevelRow[]>(res.body);
    expect(new Set(levels.map((l) => l.code))).toEqual(new Set(vendorCriticalityEnum.enumValues));
  });

  it('ranks them uniquely and gives every tier a positive cadence', async () => {
    const levels = unwrap<LevelRow[]>(
      (await apiRequest(app, security, 'GET', '/vendors/criticality-levels')).body,
    );
    const ranks = levels.map((l) => l.rank);
    expect(new Set(ranks).size).toBe(ranks.length);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    // A zero interval would make every assessment instantly overdue.
    for (const level of levels) expect(level.reviewIntervalMonths).toBeGreaterThan(0);
    // More critical means more often, which is the whole point of the tiering.
    const byCode = Object.fromEntries(levels.map((l) => [l.code, l]));
    expect(byCode.critical.reviewIntervalMonths).toBeLessThan(byCode.low.reviewIntervalMonths);
    expect(byCode.critical.requiresIndependentEvidence).toBe(true);
  });
});

describe('registering', () => {
  it('registers as prospective, not live', async () => {
    const vendor = await register();
    expect(vendor.status).toBe('prospective');
    expect(vendor.reviewDueOn).toBeNull();
  });

  it('refuses a duplicate reference', async () => {
    const vendor = await register();
    const res = await apiRequest(app, security, 'POST', '/vendors', {
      reference: vendor.reference,
      name: 'Someone else',
      services: 'Provides a different service to us entirely.',
      criticality: 'low',
      ownerId: FIXTURE.SECURITY.id,
    });
    expect(res.status).toBe(409);
    expect(errorCode(res.body)).toBe('CONFLICT');
  });

  it('refuses an owner who does not exist', async () => {
    const res = await apiRequest(app, security, 'POST', '/vendors', {
      reference: nextRef(),
      name: 'Orphan',
      services: 'Provides a service nobody is accountable for.',
      criticality: 'low',
      ownerId: '00000000-0000-7000-8000-0000000000ff',
    });
    expect(res.status).toBe(404);
  });

  it('refuses a contract window that runs backwards with a code, not a 500', async () => {
    const res = await apiRequest(app, security, 'POST', '/vendors', {
      reference: nextRef(),
      name: 'Backwards',
      services: 'Provides a service to us on an impossible schedule.',
      criticality: 'low',
      ownerId: FIXTURE.SECURITY.id,
      contractStartsOn: '2027-01-01',
      contractEndsOn: '2026-01-01',
    });
    expect(res.status).toBe(412);
    expect(errorCode(res.body)).toBe('VENDOR_INVALID_CONTRACT_WINDOW');
  });
});

describe('the go-live gate', () => {
  it('refuses a supplier nobody has assessed', async () => {
    const vendor = await register();
    const res = await apiRequest(app, admin, 'POST', `/vendors/${vendor.id}/activate`);
    expect(res.status).toBe(412);
    expect(errorCode(res.body)).toBe('VENDOR_ASSESSMENT_REQUIRED');
  });

  it('refuses when the most recent assessment failed', async () => {
    // The LATEST assessment decides: an old pass followed by a fail must not let them through.
    const vendor = await register();
    await assess(vendor.id, { outcome: 'pass' });
    await assess(vendor.id, { outcome: 'fail', findings: FINDINGS });

    const res = await apiRequest(app, admin, 'POST', `/vendors/${vendor.id}/activate`);
    expect(res.status).toBe(412);
    expect(errorCode(res.body)).toBe('VENDOR_ASSESSMENT_REQUIRED');
  });

  it('accepts a conditional pass', async () => {
    const vendor = await register();
    await assess(vendor.id, { outcome: 'pass_with_conditions', conditions: CONDITIONS });
    const res = await apiRequest(app, admin, 'POST', `/vendors/${vendor.id}/activate`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(unwrap<VendorRow>(res.body).status).toBe('active');
  });

  it('refuses approval to an identity holding only manage', async () => {
    // The other half of the separation. Without this, `vendor.manage` would quietly include the
    // power to make the organisation depend on a supplier.
    const vendor = await register();
    await assess(vendor.id);
    const res = await apiRequest(app, security, 'POST', `/vendors/${vendor.id}/activate`);
    expect(res.status).toBe(403);
  });

  it('lets the same identity suspend, because stopping is not the risky direction', async () => {
    const vendor = await liveVendor();
    const res = await apiRequest(app, security, 'POST', `/vendors/${vendor.id}/suspend`, {
      reason: WHY,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(unwrap<VendorRow>(res.body).status).toBe('suspended');
  });

  it('holds reinstatement to the same bar as approval', async () => {
    const vendor = await liveVendor();
    await apiRequest(app, security, 'POST', `/vendors/${vendor.id}/suspend`, { reason: WHY });
    // A failure recorded while suspended must block the way back.
    await assess(vendor.id, { outcome: 'fail', findings: FINDINGS });

    const res = await apiRequest(app, admin, 'POST', `/vendors/${vendor.id}/reinstate`);
    expect(res.status).toBe(412);
    expect(errorCode(res.body)).toBe('VENDOR_ASSESSMENT_REQUIRED');

    // Fixed, reassessed, and back.
    await assess(vendor.id, { outcome: 'pass' });
    const second = await apiRequest(app, admin, 'POST', `/vendors/${vendor.id}/reinstate`);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(unwrap<VendorRow>(second.body).status).toBe('active');
  });

  it('refuses to skip a state', async () => {
    // `prospective` cannot become `suspended` — there is nothing to suspend yet.
    const vendor = await register();
    const res = await apiRequest(app, security, 'POST', `/vendors/${vendor.id}/suspend`, {
      reason: WHY,
    });
    expect(res.status).toBe(412);
    expect(errorCode(res.body)).toBe('VENDOR_NOT_IN_STATE');
  });
});

describe('data processors', () => {
  it('may be registered before the agreement exists', async () => {
    // The normal order of events, and why the CHECK is scoped to `active`.
    const vendor = await register({ dataProcessor: true });
    expect(vendor.dataProcessor).toBe(true);
    expect(vendor.dataProcessingAgreementId).toBeNull();
  });

  it('cannot go live without one', async () => {
    const vendor = await register({ dataProcessor: true });
    await assess(vendor.id);
    const res = await apiRequest(app, admin, 'POST', `/vendors/${vendor.id}/activate`);
    expect(res.status).toBe(412);
    expect(errorCode(res.body)).toBe('VENDOR_AGREEMENT_REQUIRED');
  });

  it('goes live once the agreement is recorded', async () => {
    const vendor = await register({
      dataProcessor: true,
      dataProcessingAgreementId: '00000000-0000-7000-8000-0000000d0a01',
    });
    await assess(vendor.id);
    const res = await apiRequest(app, admin, 'POST', `/vendors/${vendor.id}/activate`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('cannot have the agreement cleared while live', async () => {
    const vendor = await liveVendor({
      dataProcessor: true,
      dataProcessingAgreementId: '00000000-0000-7000-8000-0000000d0a02',
    });
    const res = await apiRequest(app, security, 'PATCH', `/vendors/${vendor.id}`, {
      dataProcessingAgreementId: null,
    });
    expect(res.status).toBe(412);
    expect(errorCode(res.body)).toBe('VENDOR_AGREEMENT_REQUIRED');
  });

  it('is listed by the processors filter', async () => {
    const processor = await register({
      dataProcessor: true,
      dataProcessingAgreementId: '00000000-0000-7000-8000-0000000d0a03',
    });
    const plain = await register({ dataProcessor: false });
    const rows = unwrap<VendorListRow[]>(
      (await apiRequest(app, security, 'GET', '/vendors?processorsOnly=true&limit=100')).body,
    );
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(processor.id);
    expect(ids).not.toContain(plain.id);
  });
});

describe('assessments and the cadence', () => {
  it('moves the review date to the assessment date plus the tier interval', async () => {
    // `critical` is seeded at 6 months. Asserting the EXACT date is the point: a cadence that is
    // "some date in the future" is not a cadence.
    const vendor = await register({ criticality: 'critical' });
    await assess(vendor.id, { assessedAt: '2026-03-15T09:00:00.000Z' });

    const after = unwrap<VendorRow>(
      (await apiRequest(app, security, 'GET', `/vendors/${vendor.id}`)).body,
    );
    expect(after.reviewDueOn).toBe('2026-09-15');
  });

  it('uses the tier own interval, not one default for everybody', async () => {
    // `low` is seeded at 36 months.
    const vendor = await register({ criticality: 'low' });
    await assess(vendor.id, { assessedAt: '2026-03-15T09:00:00.000Z' });

    const after = unwrap<VendorRow>(
      (await apiRequest(app, security, 'GET', `/vendors/${vendor.id}`)).body,
    );
    expect(after.reviewDueOn).toBe('2029-03-15');
  });

  it('does not accept a review date from the caller', async () => {
    // A cadence a caller can move is not a cadence. The field is not in the patch schema at all, so
    // this is a validation failure rather than a silent no-op — which matters, because a no-op would
    // look like it worked.
    const vendor = await register();
    const res = await apiRequest(app, security, 'PATCH', `/vendors/${vendor.id}`, {
      reviewDueOn: '2099-01-01',
    });
    expect(res.status).toBe(422);
  });

  it('refuses a conditional pass with no conditions', async () => {
    const vendor = await register();
    const res = await apiRequest(app, security, 'POST', `/vendors/${vendor.id}/assessments`, {
      outcome: 'pass_with_conditions',
      scope: SCOPE,
    });
    // The DTO would accept it (the field is optional for other outcomes), so this is the service's
    // refusal in front of `ck_vendor_assessment_conditions` — never a 500 from the CHECK.
    expect(res.status).toBe(412);
    expect(errorCode(res.body)).toBe('VENDOR_ASSESSMENT_INCOMPLETE');
  });

  it('refuses a failure with no findings', async () => {
    const vendor = await register();
    const res = await apiRequest(app, security, 'POST', `/vendors/${vendor.id}/assessments`, {
      outcome: 'fail',
      scope: SCOPE,
    });
    expect(res.status).toBe(412);
    expect(errorCode(res.body)).toBe('VENDOR_ASSESSMENT_INCOMPLETE');
  });

  it('returns the history latest first, with the assessor recorded', async () => {
    const vendor = await register();
    await assess(vendor.id, { assessedAt: '2026-01-01T00:00:00.000Z' });
    await assess(vendor.id, { assessedAt: '2026-06-01T00:00:00.000Z' });

    const history = unwrap<AssessmentRow[]>(
      (await apiRequest(app, security, 'GET', `/vendors/${vendor.id}/assessments`)).body,
    );
    expect(history).toHaveLength(2);
    expect(history[0].assessedAt.startsWith('2026-06-01')).toBe(true);
    expect(history[0].assessedBy).toBe(FIXTURE.SECURITY.id);
  });
});

describe('termination', () => {
  it('records the date and reason, and is terminal', async () => {
    const vendor = await liveVendor();
    const terminated = await apiRequest(app, security, 'POST', `/vendors/${vendor.id}/terminate`, {
      reason: WHY,
    });
    expect(terminated.status, JSON.stringify(terminated.body)).toBe(200);
    const row = unwrap<VendorRow>(terminated.body);
    expect(row.status).toBe('terminated');
    expect(row.terminatedAt).not.toBeNull();
    expect(row.terminationReason).toBe(WHY);

    // Nothing further is accepted.
    for (const [method, url, payload] of [
      ['PATCH', `/vendors/${vendor.id}`, { name: 'Renamed after termination' }],
      ['POST', `/vendors/${vendor.id}/assessments`, { outcome: 'pass', scope: SCOPE }],
    ] as const) {
      const res = await apiRequest(app, security, method, url, payload);
      expect(res.status, `${method} ${url}`).toBe(412);
      expect(errorCode(res.body)).toBe('VENDOR_TERMINATED');
    }

    // And there is no way back.
    const reinstated = await apiRequest(app, admin, 'POST', `/vendors/${vendor.id}/reinstate`);
    expect(reinstated.status).toBe(412);
    expect(errorCode(reinstated.body)).toBe('VENDOR_NOT_IN_STATE');
  });

  it('excludes terminated suppliers from the register unless asked for', async () => {
    const vendor = await liveVendor();
    await apiRequest(app, security, 'POST', `/vendors/${vendor.id}/terminate`, { reason: WHY });

    const current = unwrap<VendorListRow[]>(
      (await apiRequest(app, security, 'GET', `/vendors?search=${vendor.reference}`)).body,
    );
    expect(current.map((r) => r.id)).not.toContain(vendor.id);

    const including = unwrap<VendorListRow[]>(
      (
        await apiRequest(
          app,
          security,
          'GET',
          `/vendors?search=${vendor.reference}&includeTerminated=true`,
        )
      ).body,
    );
    expect(including.map((r) => r.id)).toContain(vendor.id);
  });
});

describe('reports', () => {
  it('surfaces a live supplier whose last assessment is past its cadence', async () => {
    // Backdating the LATEST assessment is how the overdue state is reached: the supplier is relied
    // upon and the last look is stale, which is the finding the report exists for.
    const vendor = await register();
    await assess(vendor.id);
    await apiRequest(app, admin, 'POST', `/vendors/${vendor.id}/activate`);
    // Backdate far enough that the 6-month critical cadence has certainly passed.
    await assess(vendor.id, { assessedAt: '2020-01-01T00:00:00.000Z' });

    const gaps = unwrap<GapRow[]>(
      (await apiRequest(app, security, 'GET', '/vendors/reports/review-gaps')).body,
    );
    const mine = gaps.find((g) => g.id === vendor.id);
    expect(mine, 'an assessment from 2020 must be overdue').toBeDefined();
    expect(mine!.daysOverdue).toBeGreaterThan(0);
    expect(mine!.dueOn).toBe('2020-07-01');
  });

  it('leaves a freshly assessed supplier off the review-gap report', async () => {
    const vendor = await liveVendor();
    const gaps = unwrap<GapRow[]>(
      (await apiRequest(app, security, 'GET', '/vendors/reports/review-gaps')).body,
    );
    expect(gaps.map((g) => g.id)).not.toContain(vendor.id);
  });

  it('leaves prospective suppliers off it too', async () => {
    // Not yet relied upon, so not yet a gap in anything.
    const vendor = await register();
    const gaps = unwrap<GapRow[]>(
      (await apiRequest(app, security, 'GET', '/vendors/reports/review-gaps')).body,
    );
    expect(gaps.map((g) => g.id)).not.toContain(vendor.id);
  });

  it('reports a critical supplier with no risk, and drops it once one is linked', async () => {
    const vendor = await liveVendor({ criticality: 'critical' });

    const before = unwrap<VendorRow[]>(
      (await apiRequest(app, security, 'GET', '/vendors/reports/critical-without-risk')).body,
    );
    expect(before.map((v) => v.id)).toContain(vendor.id);

    const riskId = await createRisk();
    const link = await apiRequest(app, security, 'PUT', `/vendors/${vendor.id}/risks/${riskId}`);
    expect(link.status, JSON.stringify(link.body)).toBe(204);

    const after = unwrap<VendorRow[]>(
      (await apiRequest(app, security, 'GET', '/vendors/reports/critical-without-risk')).body,
    );
    expect(after.map((v) => v.id)).not.toContain(vendor.id);

    // The link reads back from the vendor, and the register row counts it.
    const risks = unwrap<{ id: string }[]>(
      (await apiRequest(app, security, 'GET', `/vendors/${vendor.id}/risks`)).body,
    );
    expect(risks.map((r) => r.id)).toContain(riskId);
    const row = unwrap<VendorListRow[]>(
      (await apiRequest(app, security, 'GET', `/vendors?search=${vendor.reference}`)).body,
    )[0];
    expect(row.riskCount).toBe(1);
  });

  it('is idempotent about linking, and reports an unlink that was never linked', async () => {
    const vendor = await liveVendor();
    const riskId = await createRisk();
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(
        (await apiRequest(app, security, 'PUT', `/vendors/${vendor.id}/risks/${riskId}`)).status,
        `attempt ${attempt + 1}`,
      ).toBe(204);
    }
    expect(
      (await apiRequest(app, security, 'DELETE', `/vendors/${vendor.id}/risks/${riskId}`)).status,
    ).toBe(204);
    expect(
      (await apiRequest(app, security, 'DELETE', `/vendors/${vendor.id}/risks/${riskId}`)).status,
    ).toBe(404);
  });

  it('reports licence spend going to an unlinked or unassessed supplier', async () => {
    // An unlinked licence: the register knows nothing about who this money goes to.
    const created = await apiRequest(app, admin, 'POST', '/licenses', {
      name: `E2E Payroll SaaS ${RUN}`,
      vendor: 'Acme Payroll',
      licenseType: 'subscription',
      seatCount: 50,
      costPerSeatCents: 1500,
      renewalDate: '2027-01-31',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const licenseId = unwrap<{ id: string }>(created.body).id;

    const unlinked = unwrap<SpendRow[]>(
      (await apiRequest(app, security, 'GET', '/vendors/reports/unassessed-spend')).body,
    );
    expect(
      unlinked.find((s) => s.licenseId === licenseId),
      'unlinked licence must be flagged',
    ).toBeDefined();
    expect(unlinked.find((s) => s.licenseId === licenseId)!.vendorId).toBeNull();

    // Linking it to a vendor nobody has assessed does NOT clear the flag — that is the second shape
    // of the same gap, and the report exists to say so.
    const unassessed = await register();
    await apiRequest(app, admin, 'PATCH', `/licenses/${licenseId}`, { vendorId: unassessed.id });
    const stillFlagged = unwrap<SpendRow[]>(
      (await apiRequest(app, security, 'GET', '/vendors/reports/unassessed-spend')).body,
    );
    expect(stillFlagged.find((s) => s.licenseId === licenseId)).toBeDefined();

    // Assessing them clears it.
    await assess(unassessed.id);
    const cleared = unwrap<SpendRow[]>(
      (await apiRequest(app, security, 'GET', '/vendors/reports/unassessed-spend')).body,
    );
    expect(cleared.find((s) => s.licenseId === licenseId)).toBeUndefined();
  });
});

describe('listing', () => {
  it('lists most critical first', async () => {
    const res = await apiRequest(app, security, 'GET', '/vendors?limit=100');
    expect(res.status).toBe(200);
    const ranks = unwrap<VendorListRow[]>(res.body).map((r) => r.criticalityRank);
    expect([...ranks].sort((a, b) => b - a)).toEqual(ranks);
  });

  it('carries the tier cadence and the latest assessment on each row', async () => {
    const vendor = await liveVendor({ criticality: 'high' });
    const row = unwrap<VendorListRow[]>(
      (await apiRequest(app, security, 'GET', `/vendors?search=${vendor.reference}`)).body,
    )[0];
    expect(row.reviewIntervalMonths).toBe(12);
    expect(row.requiresIndependentEvidence).toBe(true);
    expect(row.lastOutcome).toBe('pass');
    expect(row.lastAssessedAt).not.toBeNull();
  });
});

describe('naming the relationship owner', () => {
  /*
   * WHY THIS IS ASSERTED AT ALL. The drawer showed `ownerId`, so the field that says who gets asked
   * when an assessment falls overdue or a supplier has to be suspended — the only actionable name on
   * the record — was answered with thirty-six characters identifying nobody. The name has to come
   * from the API rather than the SPA: `GET /v1/employees` needs `employee.read`, which a
   * `vendor.read` holder is not required to hold, so resolving it in the browser would hand a 403 and
   * a dash to exactly the roles that need the name.
   *
   * BOTH READS ARE ASSERTED because the register list and the single supplier are SEPARATE service
   * methods — the single one goes through `getByIdWithOwner`, while `getById` stays the write-path
   * guard for update, activate, suspend, reinstate, terminate and assess. Asserting only the list is
   * what would let the drawer quietly keep the uuid.
   */
  it('names the owner in the register and in the single supplier', async () => {
    const vendor = await register();

    const listed = unwrap<VendorListRow[]>(
      (
        await apiRequest(
          app,
          security,
          'GET',
          `/vendors?search=${encodeURIComponent(vendor.reference)}&limit=100`,
        )
      ).body,
    );
    const row = listed.find((r) => r.id === vendor.id);
    expect(row, 'the supplier under test is not in the register listing').toBeDefined();
    expect(
      row!.ownerName,
      `vendor ${row!.reference} came back with owner ${row!.ownerId} and no name`,
    ).toBeTruthy();

    const one = await apiRequest(app, security, 'GET', `/vendors/${vendor.id}`);
    expect(one.status).toBe(200);
    // The same name from the other method, not merely "some name": both resolve the same id, so a
    // mismatch would mean one of them is resolving something else.
    expect(unwrap<VendorRow>(one.body).ownerName).toBe(row!.ownerName);
  });

  /*
   * The WRITE paths deliberately do NOT resolve it. Every mutation response here is discarded by the
   * SPA, which refetches — so resolving a name on registration or a lifecycle move would be a
   * directory query nobody reads on nine endpoints. `null` is the correct answer, and specifically not
   * the uuid: falling back to the id would put back everything this removed.
   */
  it('leaves the name off a write response rather than echoing the uuid', async () => {
    const vendor = await register();
    expect(vendor.ownerName).toBeNull();
    expect(vendor.ownerId).toBe(FIXTURE.SECURITY.id);
  });
});

describe('permissions', () => {
  it('lets a read-only identity read but not register or assess', async () => {
    expect((await apiRequest(app, auditor, 'GET', '/vendors')).status).toBe(200);
    expect((await apiRequest(app, auditor, 'GET', '/vendors/reports/review-gaps')).status).toBe(
      200,
    );

    const registered = await apiRequest(app, auditor, 'POST', '/vendors', {
      reference: nextRef(),
      name: 'Auditor should not write this',
      services: 'Provides a service the auditor may not register.',
      criticality: 'low',
      ownerId: FIXTURE.SECURITY.id,
    });
    expect(registered.status).toBe(403);

    const vendor = await register();
    const assessed = await apiRequest(app, auditor, 'POST', `/vendors/${vendor.id}/assessments`, {
      outcome: 'pass',
      scope: SCOPE,
    });
    expect(assessed.status).toBe(403);
  });

  it('refuses an identity holding no codes at all', async () => {
    expect((await apiRequest(app, employee, 'GET', '/vendors')).status).toBe(403);
    expect((await apiRequest(app, employee, 'GET', '/vendors/criticality-levels')).status).toBe(
      403,
    );
  });
});
