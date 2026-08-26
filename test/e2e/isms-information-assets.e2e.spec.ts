/**
 * ISMS information assets end to end: the register, classification direction, and device holdings.
 *
 * WHAT THIS EXISTS TO PIN
 * -----------------------
 *   - THE LEVELS TABLE COVERS THE ENUM. `information_assets.classification` is an FK to
 *     `isms.classification_levels`, which guarantees every classified asset has a rank and rules —
 *     but NOT that every enum value has a level row. A label with no row is unusable and would
 *     surface as a foreign-key 500 on somebody's first attempt to use it. No constraint can express
 *     that, so this is the test that does.
 *   - EVERY CHECK SURFACES AS A CODED REFUSAL, not the 500 a bare constraint violation produces:
 *     personal data at `internal`, a `public` asset rated as confidential, a `restricted` asset rated
 *     below its label, a rating off the scale.
 *   - DIRECTION IS ENFORCED BY PERMISSION. `security` holds `information_asset.manage` and can RAISE
 *     a classification; the same identity cannot lower one, in both the ways that could go wrong —
 *     403 at the declassification route it does not hold, and a coded 412 on the route it does.
 *   - THE HISTORY IS COMPLETE AND APPEND-ONLY. Registration writes the first row with a null
 *     `fromLevel`, each change adds one, and the reason travels with it.
 *   - RE-RATING IS THE WAY OUT OF A LABEL THE ASSESSMENT DOES NOT SUPPORT. `reclassify` judges the
 *     new label against the rating ALREADY STORED, and `PATCH` is the only route that can move a
 *     rating — so refused, corrected, then accepted is walked as ONE test. Either half alone passes
 *     against a build where the destination is simply unreachable.
 *   - COHERENCE OUTRANKS PERMISSION: even `admin`, holding the wildcard, cannot declassify personal
 *     data to `internal`. The permission allows a reduction, not an incoherent one.
 *   - THE LOST-LAPTOP QUESTION. A device linked to two assets reports both, worst first, and an
 *     unregistered device reports an empty list rather than a 404 the caller has to interpret.
 *   - `information_asset.read` is not `information_asset.manage`.
 *
 * REFERENCES ARE UNIQUE PER RUN — `uq_information_asset_reference` is global and the database is
 * shared with the other suites, so a fixed reference makes a spec that passes once.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d`, `pnpm db:migrate`, `pnpm db:seed`.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { informationClassificationEnum } from '../../db/schema/enums';
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
/** Holds `information_asset.read` + `information_asset.manage`, but NOT `.declassify`. */
let security: Session;
/** Holds `information_asset.read` only. */
let auditor: Session;
/** Holds the wildcard, so it is the only identity here that can declassify. */
let admin: Session;
/** Holds no permission codes at all. */
let employee: Session;

const RUN = Date.now().toString(36).toUpperCase().slice(-6);
let seq = 0;
const nextRef = (): string => `E2E-IA-${RUN}-${++seq}`;

const WHY = 'Reviewed with the data protection officer and agreed at the security forum.';

interface AssetRow {
  id: string;
  reference: string;
  name: string;
  type: string;
  classification: string;
  ownerId: string;
  ownerName: string | null;
  custodianId: string | null;
  /** The custodian's name, resolved on the read paths. Null when no custodian is named. */
  custodianName?: string | null;
  confidentiality: number;
  integrity: number;
  availability: number;
  personalData: boolean;
  reviewDueOn: string | null;
  lastReviewedAt: string | null;
  retiredAt: string | null;
}
interface AssetListRow extends AssetRow {
  classificationRank: number;
  encryptionRequired: boolean;
  deviceCount: number;
}
interface LevelRow {
  code: string;
  rank: number;
  label: string;
  handlingRules: string;
  encryptionRequired: boolean;
}
interface ChangeRow {
  fromLevel: string | null;
  toLevel: string;
  reason: string;
  changedBy: string;
}
interface HoldingRow {
  informationAssetId: string;
  reference: string;
  classification: string;
  classificationRank: number;
  personalData: boolean;
}
interface SummaryRow {
  classification: string;
  rank: number;
  assets: number;
  personalDataAssets: number;
  onDevices: number;
}

/**
 * Register an asset, defaulting to a coherent `confidential` personal-data system.
 *
 * OVERRIDES FIRST, session second. The other way round reads naturally but is a trap: almost every
 * call here varies the payload and not the identity, so `register({ personalData: false })` is the
 * obvious thing to write — and with a session-first signature that silently becomes the session,
 * producing `Bearer undefined` and a 401 that looks like an auth bug rather than a typo.
 */
async function register(
  over: Record<string, unknown> = {},
  session: Session = security,
): Promise<AssetRow> {
  const res = await apiRequest(app, session, 'POST', '/information-assets', {
    reference: nextRef(),
    name: 'Payroll system',
    description: 'Salary, bank details and tax records for staff.',
    type: 'system',
    classification: 'confidential',
    classificationReason: 'Holds salary and bank details for every member of staff.',
    ownerId: FIXTURE.SECURITY.id,
    confidentiality: 4,
    integrity: 4,
    availability: 3,
    personalData: true,
    ...over,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return unwrap<AssetRow>(res.body);
}

/** A device from the hardware inventory, to link information to. */
async function createDevice(tag: string): Promise<string> {
  const res = await apiRequest(app, admin, 'POST', '/assets', {
    assetTag: tag,
    type: 'laptop',
    manufacturer: 'Acme',
    model: 'Book 13',
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

describe('classification levels', () => {
  it('has a level row for every value the enum allows', async () => {
    // The FK guarantees a classified asset has a level; it does NOT guarantee the reverse. A label in
    // the enum with no row here is a label that cannot be used, and the failure would appear as a
    // foreign-key 500 rather than as anything about classification.
    const res = await apiRequest(app, security, 'GET', '/information-assets/classification-levels');
    expect(res.status).toBe(200);
    const levels = unwrap<LevelRow[]>(res.body);
    expect(new Set(levels.map((l) => l.code))).toEqual(
      new Set(informationClassificationEnum.enumValues),
    );
  });

  it('ranks them uniquely and hands over the handling rules', async () => {
    const levels = unwrap<LevelRow[]>(
      (await apiRequest(app, security, 'GET', '/information-assets/classification-levels')).body,
    );
    const ranks = levels.map((l) => l.rank);
    expect(new Set(ranks).size).toBe(ranks.length);
    // Ascending as returned, so a UI that renders them in order is not guessing.
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    // Rules have substance: the level exists so somebody can be told how to handle the information.
    for (const level of levels) expect(level.handlingRules.length).toBeGreaterThan(40);
    // The two top levels mandate encryption; the register's list view reads this per row.
    const byCode = Object.fromEntries(levels.map((l) => [l.code, l]));
    expect(byCode.restricted.encryptionRequired).toBe(true);
    expect(byCode.confidential.encryptionRequired).toBe(true);
    expect(byCode.public.encryptionRequired).toBe(false);
  });
});

describe('registering', () => {
  it('records the asset with its first classification history row', async () => {
    const asset = await register();
    expect(asset.classification).toBe('confidential');

    const history = unwrap<ChangeRow[]>(
      (
        await apiRequest(
          app,
          security,
          'GET',
          `/information-assets/${asset.id}/classification-history`,
        )
      ).body,
    );
    expect(history).toHaveLength(1);
    // Null `fromLevel` is the initial classification: the label traces to a decision rather than to
    // an unexplained default.
    expect(history[0].fromLevel).toBeNull();
    expect(history[0].toLevel).toBe('confidential');
    expect(history[0].changedBy).toBe(FIXTURE.SECURITY.id);
  });

  it('refuses a duplicate reference', async () => {
    const asset = await register();
    const res = await apiRequest(app, security, 'POST', '/information-assets', {
      reference: asset.reference,
      name: 'Something else',
      type: 'database',
      classification: 'internal',
      classificationReason: WHY,
      ownerId: FIXTURE.SECURITY.id,
      confidentiality: 2,
      integrity: 2,
      availability: 2,
    });
    expect(res.status).toBe(409);
    expect(errorCode(res.body)).toBe('CONFLICT');
  });

  it('refuses an owner who does not exist', async () => {
    const res = await apiRequest(app, security, 'POST', '/information-assets', {
      reference: nextRef(),
      name: 'Orphan register entry',
      type: 'other',
      classification: 'internal',
      classificationReason: WHY,
      ownerId: '00000000-0000-7000-8000-0000000000ff',
      confidentiality: 2,
      integrity: 2,
      availability: 2,
    });
    // `owner_id` carries no cross-schema FK, so this is the only thing standing between a register
    // and an accountable name nobody holds.
    expect(res.status).toBe(404);
  });

  it('names BOTH bad references in one refusal, not the first one it hit', async () => {
    const ghostOwner = '00000000-0000-7000-8000-0000000000fe';
    const ghostCustodian = '00000000-0000-7000-8000-0000000000fd';

    const res = await apiRequest(app, security, 'POST', '/information-assets', {
      reference: nextRef(),
      name: 'Two orphaned references',
      type: 'other',
      classification: 'internal',
      classificationReason: WHY,
      ownerId: ghostOwner,
      custodianId: ghostCustodian,
      confidentiality: 2,
      integrity: 2,
      availability: 2,
    });

    /*
     * TWO REFERENCES, ONE ROUND TRIP, BOTH NAMED. The old form validated these one at a time and threw
     * on the first, so a form with two bad ids told the user about the owner, and the corrected submit
     * then failed on the custodian. Both ids appearing here is what proves the check batched them
     * rather than short-circuiting.
     */
    expect(res.status).toBe(404);
    expect(errorCode(res.body)).toBe('EMPLOYEE_NOT_FOUND');
    const message = JSON.stringify(res.body);
    expect(message).toContain(ghostOwner);
    expect(message).toContain(ghostCustodian);
  });

  it('accepts a real owner with no custodian, so an absent optional reference is not a failure', async () => {
    // The other half of `assertExist`: nullish ids are skipped, which is what let twelve call sites
    // drop their `if (dto.custodianId)` guard. If the skip were wrong, this would 404 on `undefined`.
    const res = await apiRequest(app, security, 'POST', '/information-assets', {
      reference: nextRef(),
      name: 'Owner only, no custodian',
      type: 'other',
      classification: 'internal',
      classificationReason: WHY,
      ownerId: FIXTURE.SECURITY.id,
      confidentiality: 2,
      integrity: 2,
      availability: 2,
    });
    expect(res.status).toBe(201);
  });

  it.each([
    [
      'personal data at internal',
      { classification: 'internal', confidentiality: 3, personalData: true },
      'INFORMATION_ASSET_PERSONAL_DATA_EXPOSED',
    ],
    [
      'public rated as confidential',
      { classification: 'public', confidentiality: 4, personalData: false },
      'INFORMATION_ASSET_CLASSIFICATION_MISMATCH',
    ],
    [
      'restricted rated below its label',
      { classification: 'restricted', confidentiality: 2, personalData: false },
      'INFORMATION_ASSET_CLASSIFICATION_MISMATCH',
    ],
  ])('refuses %s with a code rather than a 500', async (_name, over, code) => {
    const res = await apiRequest(app, security, 'POST', '/information-assets', {
      reference: nextRef(),
      name: 'Incoherent entry',
      type: 'dataset',
      classificationReason: WHY,
      ownerId: FIXTURE.SECURITY.id,
      integrity: 3,
      availability: 3,
      ...over,
    });
    expect(res.status).toBe(412);
    expect(errorCode(res.body)).toBe(code);
  });

  it('rejects a rating off the scale at validation', async () => {
    // The DTO catches this before the service does, which is why the status is 422 and not 412. Both
    // are refusals with a code; what matters is that neither is a 500 from the CHECK.
    const res = await apiRequest(app, security, 'POST', '/information-assets', {
      reference: nextRef(),
      name: 'Off the scale',
      type: 'other',
      classification: 'internal',
      classificationReason: WHY,
      ownerId: FIXTURE.SECURITY.id,
      confidentiality: 9,
      integrity: 2,
      availability: 2,
    });
    expect(res.status).toBe(422);
  });
});

describe('classification direction', () => {
  it('lets the holder of manage RAISE a classification, and records why', async () => {
    const asset = await register();
    const res = await apiRequest(
      app,
      security,
      'POST',
      `/information-assets/${asset.id}/reclassify`,
      {
        classification: 'restricted',
        reason: WHY,
      },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(unwrap<AssetRow>(res.body).classification).toBe('restricted');

    const history = unwrap<ChangeRow[]>(
      (
        await apiRequest(
          app,
          security,
          'GET',
          `/information-assets/${asset.id}/classification-history`,
        )
      ).body,
    );
    expect(history).toHaveLength(2);
    expect(history[1]).toMatchObject({
      fromLevel: 'confidential',
      toLevel: 'restricted',
      reason: WHY,
    });
  });

  it('refuses the same level it already carries', async () => {
    const asset = await register();
    const res = await apiRequest(
      app,
      security,
      'POST',
      `/information-assets/${asset.id}/reclassify`,
      {
        classification: 'confidential',
        reason: WHY,
      },
    );
    expect(res.status).toBe(412);
    expect(errorCode(res.body)).toBe('INFORMATION_ASSET_NOT_RECLASSIFIED');
  });

  it('refuses a REDUCTION through the manage route, naming the permission needed', async () => {
    const asset = await register({ personalData: false });
    const res = await apiRequest(
      app,
      security,
      'POST',
      `/information-assets/${asset.id}/reclassify`,
      {
        classification: 'internal',
        reason: WHY,
      },
    );
    expect(res.status).toBe(412);
    expect(errorCode(res.body)).toBe('INFORMATION_ASSET_DECLASSIFY_REQUIRED');
  });

  it('refuses the declassification route to an identity holding only manage', async () => {
    // The other half of the same rule. Without this, the coded 412 above could be the ONLY guard, and
    // a caller who found the second route would walk around it.
    const asset = await register({ personalData: false });
    const res = await apiRequest(
      app,
      security,
      'POST',
      `/information-assets/${asset.id}/declassify`,
      {
        classification: 'internal',
        reason: WHY,
      },
    );
    expect(res.status).toBe(403);
  });

  it('lets the wildcard holder declassify, and audits it as its own act', async () => {
    const asset = await register({ personalData: false });
    const res = await apiRequest(app, admin, 'POST', `/information-assets/${asset.id}/declassify`, {
      classification: 'internal',
      reason: WHY,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(unwrap<AssetRow>(res.body).classification).toBe('internal');

    const actions = unwrap<{ action: string }[]>(
      (await apiRequest(app, admin, 'GET', `/audit-logs?resourceId=${asset.id}&limit=50`)).body,
    ).map((a) => a.action);
    // Its OWN action, so "show me every declassification this quarter" is a query over the trail
    // rather than a filter somebody has to remember to apply.
    expect(actions).toContain('information_asset.declassified');
    expect(actions).not.toContain('information_asset.reclassified');
  });

  it('will not declassify personal data below what protects it, even for the wildcard holder', async () => {
    // The permission allows a REDUCTION; it does not allow an INCOHERENT one. This is the case the
    // whole separation exists for.
    const asset = await register({ personalData: true });
    const res = await apiRequest(app, admin, 'POST', `/information-assets/${asset.id}/declassify`, {
      classification: 'internal',
      reason: WHY,
    });
    expect(res.status).toBe(412);
    expect(errorCode(res.body)).toBe('INFORMATION_ASSET_PERSONAL_DATA_EXPOSED');
  });

  it('requires a reason with substance in either direction', async () => {
    const asset = await register();
    const res = await apiRequest(
      app,
      security,
      'POST',
      `/information-assets/${asset.id}/reclassify`,
      {
        classification: 'restricted',
        reason: 'n/a',
      },
    );
    // `ck_asset_classification_history_reason` demands 10 characters; the DTO refuses first, so the
    // history cannot hold a justification that justifies nothing.
    expect(res.status).toBe(422);
  });
});

describe('re-rating', () => {
  it('judges a patch against the label already stored', async () => {
    const asset = await register({
      classification: 'public',
      confidentiality: 1,
      personalData: false,
    });
    const res = await apiRequest(app, security, 'PATCH', `/information-assets/${asset.id}`, {
      confidentiality: 4,
    });
    expect(res.status).toBe(412);
    expect(errorCode(res.body)).toBe('INFORMATION_ASSET_CLASSIFICATION_MISMATCH');
  });

  it('will not set the personal-data flag on an asset the label does not protect', async () => {
    const asset = await register({
      classification: 'internal',
      confidentiality: 2,
      personalData: false,
    });
    const res = await apiRequest(app, security, 'PATCH', `/information-assets/${asset.id}`, {
      personalData: true,
    });
    expect(res.status).toBe(412);
    expect(errorCode(res.body)).toBe('INFORMATION_ASSET_PERSONAL_DATA_EXPOSED');
  });

  it('accepts a coherent re-rating', async () => {
    const asset = await register();
    const res = await apiRequest(app, security, 'PATCH', `/information-assets/${asset.id}`, {
      integrity: 5,
      availability: 4,
      location: 'eu-west-1',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(unwrap<AssetRow>(res.body)).toMatchObject({ integrity: 5, availability: 4 });
  });

  it('does not accept a classification smuggled through the patch', async () => {
    const asset = await register();
    const res = await apiRequest(app, security, 'PATCH', `/information-assets/${asset.id}`, {
      classification: 'public',
    });
    // The field is not in the schema, so this is a validation failure rather than a silent no-op —
    // which matters, because a silent no-op would look like a successful reclassification.
    expect(res.status).toBe(422);
    expect(
      unwrap<AssetRow>(
        (await apiRequest(app, security, 'GET', `/information-assets/${asset.id}`)).body,
      ).classification,
    ).toBe('confidential');
  });

  it('leaves the descriptive fields corrected and the classification untouched', async () => {
    const asset = await register({ name: 'Payrol system', location: 'on-prem' });
    const res = await apiRequest(app, security, 'PATCH', `/information-assets/${asset.id}`, {
      name: 'Payroll system',
      custodianId: FIXTURE.ADMIN.id,
      location: 'eu-west-1 / RDS',
      retentionMonths: 84,
      reviewDueOn: '2027-03-31',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    /*
     * THE CLASSIFICATION IS ASSERTED ON A PATCH THAT NEVER MENTIONED IT.
     *
     * The 422 above proves the field is rejected when sent. This proves the other half: correcting
     * the things around it does not move it either. Both matter because the correction form sends a
     * whole body every time — the day somebody adds `classification` to that body to "keep the two
     * forms symmetrical", the label starts changing with no history row and no `declassify`
     * permission, and the register stops being able to account for its own labels.
     */
    expect(unwrap<AssetRow>(res.body)).toMatchObject({
      name: 'Payroll system',
      classification: 'confidential',
      custodianId: FIXTURE.ADMIN.id,
      reviewDueOn: '2027-03-31',
    });
    // And no history row was written, because nothing classification-shaped happened. Registration's
    // row is the only one there.
    const changes = unwrap<ChangeRow[]>(
      (
        await apiRequest(
          app,
          security,
          'GET',
          `/information-assets/${asset.id}/classification-history`,
        )
      ).body,
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].fromLevel).toBeNull();
  });

  /**
   * THE DEAD END, WALKED END TO END.
   *
   * `reclassify` validates the NEW label against the CIA rating ALREADY STORED, and `assertCoherent`
   * refuses `restricted` below a confidentiality of 4. `PATCH` is the only route that can move a
   * rating. So while no screen called that `PATCH`, an asset registered `internal` at 3 could never
   * become `restricted` from the product at all: the reclassify call 412'd, and there was nothing to
   * raise the rating with.
   *
   * The three steps are one test on purpose. The refusal alone would pass against a build where
   * `restricted` is simply unreachable; the success alone would pass against a build that never
   * enforced the coherence rule. Only the pair says "refused for the right reason, and the documented
   * way out actually works".
   */
  it('re-rating is the way out of a reclassification the rating refuses', async () => {
    const asset = await register({
      classification: 'internal',
      confidentiality: 3,
      // Not personal data: at `internal` the API would refuse that pair for a different reason, and a
      // test that can fail two ways cannot say which rule it is pinning.
      personalData: false,
    });

    // 1. REFUSED — the label outruns the assessment, and the refusal names the number it wanted.
    const tooLow = await apiRequest(
      app,
      security,
      'POST',
      `/information-assets/${asset.id}/reclassify`,
      { classification: 'restricted', reason: WHY },
    );
    expect(tooLow.status, JSON.stringify(tooLow.body)).toBe(412);
    expect(errorCode(tooLow.body)).toBe('INFORMATION_ASSET_CLASSIFICATION_MISMATCH');

    // 2. CORRECT THE RATING. The reassessment that justifies the label, through the only route that
    // can record it.
    const rerated = await apiRequest(app, security, 'PATCH', `/information-assets/${asset.id}`, {
      confidentiality: 5,
    });
    expect(rerated.status, JSON.stringify(rerated.body)).toBe(200);
    expect(unwrap<AssetRow>(rerated.body).confidentiality).toBe(5);
    // Still `internal`: the re-rating is not a reclassification, and if it were then step 3 would be
    // proving nothing.
    expect(unwrap<AssetRow>(rerated.body).classification).toBe('internal');

    // 3. NOW IT GOES THROUGH, and it is recorded as the change it is.
    const raised = await apiRequest(
      app,
      security,
      'POST',
      `/information-assets/${asset.id}/reclassify`,
      { classification: 'restricted', reason: WHY },
    );
    expect(raised.status, JSON.stringify(raised.body)).toBe(200);
    expect(unwrap<AssetRow>(raised.body).classification).toBe('restricted');

    const changes = unwrap<ChangeRow[]>(
      (
        await apiRequest(
          app,
          security,
          'GET',
          `/information-assets/${asset.id}/classification-history`,
        )
      ).body,
    );
    expect(changes.map((c) => [c.fromLevel, c.toLevel])).toEqual(
      expect.arrayContaining([['internal', 'restricted']]),
    );
  });
});

describe('review and retirement', () => {
  it('stamps a review and moves the next one', async () => {
    const asset = await register();
    const res = await apiRequest(
      app,
      security,
      'POST',
      `/information-assets/${asset.id}/reviewed`,
      {
        reviewDueOn: '2027-06-30',
      },
    );
    expect(res.status).toBe(200);
    const reviewed = unwrap<AssetRow>(res.body);
    expect(reviewed.reviewDueOn).toBe('2027-06-30');
    expect(reviewed.lastReviewedAt).not.toBeNull();
  });

  it('finds assets due for review on or before a date', async () => {
    const asset = await register({ reviewDueOn: '2026-01-31' });
    const res = await apiRequest(
      app,
      security,
      'GET',
      '/information-assets?reviewDueOnOrBefore=2026-02-01&limit=100',
    );
    expect(res.status).toBe(200);
    const rows = unwrap<AssetListRow[]>(res.body);
    expect(rows.map((r) => r.id)).toContain(asset.id);
  });

  it('retires an asset once, and then accepts nothing further', async () => {
    const asset = await register();
    expect(
      (await apiRequest(app, security, 'POST', `/information-assets/${asset.id}/retire`)).status,
    ).toBe(200);

    const second = await apiRequest(
      app,
      security,
      'POST',
      `/information-assets/${asset.id}/retire`,
    );
    expect(second.status).toBe(412);
    expect(errorCode(second.body)).toBe('INFORMATION_ASSET_RETIRED');

    const patched = await apiRequest(app, security, 'PATCH', `/information-assets/${asset.id}`, {
      name: 'Renamed after retirement',
    });
    expect(patched.status).toBe(412);
    expect(errorCode(patched.body)).toBe('INFORMATION_ASSET_RETIRED');

    const reclassified = await apiRequest(
      app,
      security,
      'POST',
      `/information-assets/${asset.id}/reclassify`,
      {
        classification: 'restricted',
        reason: WHY,
      },
    );
    expect(reclassified.status).toBe(412);
    expect(errorCode(reclassified.body)).toBe('INFORMATION_ASSET_RETIRED');
  });

  it('excludes retired assets from the register unless asked for', async () => {
    const asset = await register();
    await apiRequest(app, security, 'POST', `/information-assets/${asset.id}/retire`);

    const current = unwrap<AssetListRow[]>(
      (await apiRequest(app, security, 'GET', `/information-assets?search=${asset.reference}`))
        .body,
    );
    expect(current.map((r) => r.id)).not.toContain(asset.id);

    const including = unwrap<AssetListRow[]>(
      (
        await apiRequest(
          app,
          security,
          'GET',
          `/information-assets?search=${asset.reference}&includeRetired=true`,
        )
      ).body,
    );
    expect(including.map((r) => r.id)).toContain(asset.id);
  });
});

describe('devices', () => {
  it('answers what one device holds, worst classification first', async () => {
    const device = await createDevice(`E2E-DEV-${RUN}-A`);
    const lower = await register({
      classification: 'internal',
      confidentiality: 2,
      personalData: false,
      name: 'Team wiki export',
    });
    const higher = await register({ classification: 'restricted', confidentiality: 5 });

    for (const asset of [lower, higher]) {
      const link = await apiRequest(
        app,
        security,
        'PUT',
        `/information-assets/${asset.id}/devices/${device}`,
      );
      expect(link.status, JSON.stringify(link.body)).toBe(204);
    }

    const holdings = unwrap<HoldingRow[]>(
      (
        await apiRequest(
          app,
          security,
          'GET',
          `/information-assets/reports/device-holdings/${device}`,
        )
      ).body,
    );
    expect(holdings.map((h) => h.reference)).toEqual([higher.reference, lower.reference]);
    // The line that decides whether a lost laptop is an incident comes first, and it says so.
    expect(holdings[0].personalData).toBe(true);
    expect(holdings[0].classificationRank).toBeGreaterThan(holdings[1].classificationRank);
  });

  it('is idempotent, and counts the link on the register row', async () => {
    const device = await createDevice(`E2E-DEV-${RUN}-B`);
    const asset = await register();
    // Twice, deliberately: the second call is the idempotency claim.
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(
        (
          await apiRequest(
            app,
            security,
            'PUT',
            `/information-assets/${asset.id}/devices/${device}`,
          )
        ).status,
        `attempt ${attempt + 1}`,
      ).toBe(204);
    }
    const devices = unwrap<{ deviceAssetId: string }[]>(
      (await apiRequest(app, security, 'GET', `/information-assets/${asset.id}/devices`)).body,
    );
    expect(devices).toHaveLength(1);

    const rows = unwrap<AssetListRow[]>(
      (await apiRequest(app, security, 'GET', `/information-assets?search=${asset.reference}`))
        .body,
    );
    expect(rows[0].deviceCount).toBe(1);
  });

  it('unlinks once and reports a second attempt', async () => {
    const device = await createDevice(`E2E-DEV-${RUN}-C`);
    const asset = await register();
    await apiRequest(app, security, 'PUT', `/information-assets/${asset.id}/devices/${device}`);

    expect(
      (
        await apiRequest(
          app,
          security,
          'DELETE',
          `/information-assets/${asset.id}/devices/${device}`,
        )
      ).status,
    ).toBe(204);
    const second = await apiRequest(
      app,
      security,
      'DELETE',
      `/information-assets/${asset.id}/devices/${device}`,
    );
    expect(second.status).toBe(404);
  });

  it('reports an empty list for a device holding nothing registered', async () => {
    // Deliberately distinguishable from a 404: the caller asking has just been told a laptop is
    // missing, and "nothing was on it" is the answer they need to be able to read.
    const unknown = '00000000-0000-7000-8000-0000000000fe';
    const res = await apiRequest(
      app,
      security,
      'GET',
      `/information-assets/reports/device-holdings/${unknown}`,
    );
    expect(res.status).toBe(200);
    expect(unwrap<HoldingRow[]>(res.body)).toEqual([]);
  });

  it('refuses to link a device to a retired asset', async () => {
    const device = await createDevice(`E2E-DEV-${RUN}-D`);
    const asset = await register();
    await apiRequest(app, security, 'POST', `/information-assets/${asset.id}/retire`);
    const res = await apiRequest(
      app,
      security,
      'PUT',
      `/information-assets/${asset.id}/devices/${device}`,
    );
    expect(res.status).toBe(412);
    expect(errorCode(res.body)).toBe('INFORMATION_ASSET_RETIRED');
  });
});

describe('reports and listing', () => {
  it('summarises the register by level, including levels holding nothing', async () => {
    await register({ classification: 'restricted', confidentiality: 5 });
    const res = await apiRequest(
      app,
      security,
      'GET',
      '/information-assets/reports/classification-summary',
    );
    expect(res.status).toBe(200);
    const lines = unwrap<SummaryRow[]>(res.body);
    // Every level appears: "we hold nothing restricted" is an answer worth printing, and a join from
    // the asset side would have omitted the line entirely.
    expect(new Set(lines.map((l) => l.classification))).toEqual(
      new Set(informationClassificationEnum.enumValues),
    );
    // Most protected first.
    expect(lines[0].rank).toBeGreaterThan(lines[lines.length - 1].rank);
    const restricted = lines.find((l) => l.classification === 'restricted')!;
    expect(restricted.assets).toBeGreaterThan(0);
    expect(restricted.personalDataAssets).toBeGreaterThan(0);
  });

  it('lists most protected first', async () => {
    const res = await apiRequest(app, security, 'GET', '/information-assets?limit=100');
    expect(res.status).toBe(200);
    const ranks = unwrap<AssetListRow[]>(res.body).map((r) => r.classificationRank);
    expect([...ranks].sort((a, b) => b - a)).toEqual(ranks);
  });

  it('filters to the personal-data holdings', async () => {
    const holding = await register({ personalData: true });
    const plain = await register({
      classification: 'internal',
      confidentiality: 2,
      personalData: false,
    });
    const rows = unwrap<AssetListRow[]>(
      (
        await apiRequest(
          app,
          security,
          'GET',
          '/information-assets?personalDataOnly=true&limit=100',
        )
      ).body,
    );
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(holding.id);
    expect(ids).not.toContain(plain.id);
    expect(rows.every((r) => r.personalData)).toBe(true);
  });

  it('matches the custodian as well as the owner', async () => {
    // One question to the person asking it — "which assets am I responsible for" — rather than two
    // filters a screen has to remember to combine.
    const asset = await register({ custodianId: FIXTURE.AUDITOR.id });
    const rows = unwrap<AssetListRow[]>(
      (
        await apiRequest(
          app,
          security,
          'GET',
          `/information-assets?ownerId=${FIXTURE.AUDITOR.id}&limit=100`,
        )
      ).body,
    );
    expect(rows.map((r) => r.id)).toContain(asset.id);
  });
});

describe('naming the owner', () => {
  /*
   * WHY THIS IS ASSERTED AT ALL. The drawer showed `ownerId`, so "who owns this information" — the
   * question the register answers second, after the label, and the one asked of whoever decided the
   * label and has to answer for it — was answered with thirty-six characters identifying nobody. The
   * name has to come from the API rather than the SPA: `GET /v1/employees` needs `employee.read`,
   * which an `information_asset.read` holder is not required to hold, so resolving it in the browser
   * would hand a 403 and a dash to exactly the roles that need the name.
   *
   * BOTH READS ARE ASSERTED because the list and the single record are SEPARATE service methods, and
   * the single one goes through `getByIdWithOwner` while every write path still goes through the
   * plain `getById` guard. Asserting only the list is what would let one screen quietly keep the uuid.
   */
  it('names the owner in the register and in the single asset', async () => {
    const asset = await register();

    const listed = unwrap<AssetListRow[]>(
      (
        await apiRequest(
          app,
          security,
          'GET',
          `/information-assets?search=${encodeURIComponent(asset.reference)}&limit=100`,
        )
      ).body,
    );
    const row = listed.find((r) => r.id === asset.id);
    expect(row, 'the asset under test is not in the register listing').toBeDefined();
    expect(
      row!.ownerName,
      `asset ${row!.reference} came back with owner ${row!.ownerId} and no name`,
    ).toBeTruthy();

    const one = await apiRequest(app, security, 'GET', `/information-assets/${asset.id}`);
    expect(one.status).toBe(200);
    // The same name from the other method, not merely "some name": both resolve the same id, so a
    // mismatch would mean one of them is resolving something else.
    expect(unwrap<AssetRow>(one.body).ownerName).toBe(row!.ownerName);
  });

  it('names the CUSTODIAN too, which sits directly under the owner', async () => {
    /*
     * Two different accountabilities on one record: the owner decides the classification, the custodian
     * operates the controls day to day. The drawer prints them one under the other, so naming only the
     * owner left a name beside a uuid on adjacent rows — which reads as an oversight rather than a
     * decision, and leaves the operational contact unidentifiable.
     *
     * A DIFFERENT person from the owner, so a resolver keyed on the wrong column cannot pass: it would
     * report the owner's name in both places.
     */
    const created = await apiRequest(app, security, 'POST', '/information-assets', {
      reference: nextRef(),
      name: 'Owner and custodian are different people',
      type: 'system',
      classification: 'internal',
      classificationReason: WHY,
      ownerId: FIXTURE.SECURITY.id,
      custodianId: FIXTURE.ADMIN.id,
      confidentiality: 2,
      integrity: 2,
      availability: 2,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = unwrap<AssetRow>(created.body).id;

    const one = unwrap<AssetRow>(
      (await apiRequest(app, security, 'GET', `/information-assets/${id}`)).body,
    );
    expect(one.custodianId).toBe(FIXTURE.ADMIN.id);
    expect(
      one.custodianName,
      `custodian ${one.custodianId} came back with no name, so the drawer shows a uuid`,
    ).toBeTruthy();
    expect(
      one.custodianName,
      'the custodian was resolved from the owner column — both rows would show one person',
    ).not.toBe(one.ownerName);
  });

  /*
   * The WRITE paths deliberately do NOT resolve it. Every mutation response here is discarded by the
   * SPA, which refetches — so resolving a name on registration, an update or a reclassification would
   * be a directory query nobody reads on nine endpoints. `null` is the correct answer, and
   * specifically not the uuid: falling back to the id would put back everything this removed.
   */
  it('leaves the name off a write response rather than echoing the uuid', async () => {
    const asset = await register();
    expect(asset.ownerName).toBeNull();
    expect(asset.ownerId).toBe(FIXTURE.SECURITY.id);
  });
});

describe('permissions', () => {
  it('lets a read-only identity read but not register', async () => {
    expect((await apiRequest(app, auditor, 'GET', '/information-assets')).status).toBe(200);
    expect(
      (await apiRequest(app, auditor, 'GET', '/information-assets/reports/classification-summary'))
        .status,
    ).toBe(200);

    const res = await apiRequest(app, auditor, 'POST', '/information-assets', {
      reference: nextRef(),
      name: 'Auditor should not be able to write this',
      type: 'other',
      classification: 'internal',
      classificationReason: WHY,
      ownerId: FIXTURE.SECURITY.id,
      confidentiality: 2,
      integrity: 2,
      availability: 2,
    });
    expect(res.status).toBe(403);
  });

  it('refuses an identity holding no codes at all', async () => {
    expect((await apiRequest(app, employee, 'GET', '/information-assets')).status).toBe(403);
    expect(
      (await apiRequest(app, employee, 'GET', '/information-assets/classification-levels')).status,
    ).toBe(403);
  });
});
