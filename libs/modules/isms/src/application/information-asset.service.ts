import { Inject, Injectable } from '@nestjs/common';
import {
  ConflictException,
  ErrorCodes,
  InjectDrizzle,
  NotFoundException,
  PreconditionFailedException,
  nameOf,
  resolveEmployeeNames,
  type DrizzleDB,
} from '@platform';
import type { Actor } from '@shared-kernel';
import { RATING_MAX, RATING_MIN, isRating } from '../domain/rating';
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE,
  AuditService,
  type ResourceAuditTrail,
} from '@modules/audit';
import {
  INFORMATION_ASSET_REPOSITORY,
  type IInformationAssetRepository,
} from '../domain/ports/information-asset.repository';
import type {
  ClassificationChange,
  ClassificationLevel,
  ClassificationSummaryLine,
  DeviceHolding,
  InformationAsset,
  InformationAssetFilters,
  InformationClassification,
  RegisterAssetInput,
  UpdateAssetInput,
} from '../domain/information-asset.types';

/**
 * Which classifications may hold personal data.
 *
 * `ck_information_asset_personal_data_classification` in TypeScript. Derived from the same two
 * labels rather than a rank comparison, because the rule is about those labels specifically: it is a
 * statement about what `internal` MEANS — readable by every employee — not about where it ranks.
 */
const PERSONAL_DATA_LEVELS: readonly InformationClassification[] = ['confidential', 'restricted'];

/**
 * The information asset register: what we hold, who owns it, how it is classified.
 *
 * WHAT THIS SERVICE OWNS THAT THE DATABASE CANNOT
 *
 * 1. DIRECTION. Raising a classification is ordinary maintenance; LOWERING it is the one change that
 *    makes information easier to reach. The two arrive through different methods, gated by different
 *    permissions at the route, and `declassify` is the only one that will accept a reduction. A CHECK
 *    cannot see the previous value, so this is necessarily here rather than in the schema.
 *
 * 2. THE RANKING COMES FROM THE DATABASE. "Is this a reduction?" is a comparison of the ranks on
 *    `isms.classification_levels` — never of the enum's declaration order, and never of a copy of the
 *    ordering kept in this file. A level inserted between two others changes the answer with no code
 *    change, which is the only way that stays correct.
 *
 * 3. EVERY CHECK IS RESTATED AS A CODED REFUSAL, because a raw constraint violation reaches the
 *    caller as a 500 with no error code, and the screen that has to explain "personal data cannot be
 *    internal" gets nothing to work with. They are restated ONCE, in `assertCoherent`, against the
 *    row as it WILL be — so re-rating an asset and reclassifying it cannot disagree about the rule.
 *
 * 4. A RETIRED ASSET ACCEPTS NOTHING NEW — no re-rating, no reclassification, no device link. The row
 *    stays because a risk assessment and an incident from last year reference it, and a CHECK cannot
 *    express "only if the referenced row is not retired" without a trigger.
 *
 * 5. THE HISTORY IS WRITTEN IN THE SAME TRANSACTION as the change it explains. A label whose history
 *    row is missing is a label nobody can account for, and the register's whole value is being
 *    accountable.
 */
@Injectable()
export class InformationAssetService {
  private readonly trail: ResourceAuditTrail;

  constructor(
    @Inject(INFORMATION_ASSET_REPOSITORY) private readonly repo: IInformationAssetRepository,
    @InjectDrizzle() private readonly db: DrizzleDB,
    private readonly audit: AuditService,
  ) {
    // Resource type named ONCE — see `AuditService.forResource`.
    this.trail = audit.forResource(AUDIT_RESOURCE.INFORMATION_ASSET);
  }

  // ── Levels ───────────────────────────────────────────────────────────────────

  /** The labels, their ranking and the handling each demands. */
  async listLevels(): Promise<ClassificationLevel[]> {
    return this.repo.listLevels();
  }

  // ── Register ─────────────────────────────────────────────────────────────────

  async register(input: RegisterAssetInput, actor: Actor): Promise<InformationAsset> {
    if (await this.repo.findByReference(input.reference)) {
      throw new ConflictException(
        ErrorCodes.CONFLICT,
        `Information asset reference '${input.reference}' is already registered`,
      );
    }
    this.assertCoherent({
      classification: input.classification,
      confidentiality: input.confidentiality,
      integrity: input.integrity,
      availability: input.availability,
      personalData: input.personalData ?? false,
      retentionMonths: input.retentionMonths ?? null,
    });

    return this.db.transaction(async (tx) => {
      // The repository writes the asset and its first history row together — see its `create`.
      const asset = await this.repo.create({ ...input, registeredBy: actor.sub }, tx);
      await this.trail.record(AUDIT_ACTION.INFORMATION_ASSET_REGISTERED, asset.id, actor, tx, {
        after: {
          reference: asset.reference,
          name: asset.name,
          classification: asset.classification,
          personalData: asset.personalData,
          ownerId: asset.ownerId,
        },
      });
      return asset;
    });
  }

  async getById(id: string): Promise<InformationAsset> {
    const asset = await this.repo.findById(id);
    if (!asset) {
      throw new NotFoundException(ErrorCodes.NOT_FOUND, `Information asset ${id} not found`);
    }
    return asset;
  }

  /**
   * One asset, with its owner named — the drawer's read path.
   *
   * Separate from `getById` rather than folded into it, because that one is the guard every write
   * path calls first (update, reclassify, declassify, review, retire, link a device) and none of
   * those render an owner. Widening it would have added a lookup to nine mutations for one screen.
   */
  async getByIdWithOwner(
    id: string,
  ): Promise<InformationAsset & { ownerName: string | null; custodianName: string | null }> {
    const asset = await this.getById(id);
    /*
     * Owner AND custodian. They are two different accountabilities — the owner decides the
     * classification, the custodian operates the controls — and the drawer prints them one under the
     * other. Naming only the first would have left a name beside a uuid on adjacent rows, which reads
     * as an oversight rather than a decision.
     */
    const names = await resolveEmployeeNames(this.db, [asset.ownerId, asset.custodianId]);
    return {
      ...asset,
      ownerName: nameOf(names, asset.ownerId),
      custodianName: nameOf(names, asset.custodianId),
    };
  }

  async list(filters: InformationAssetFilters, limit: number, offset: number) {
    const page = await this.repo.list(filters, limit, offset);
    /*
     * OWNER NAMES for the whole page, in one query.
     *
     * "Who owns this information" is the question the register answers second, after "how is it
     * classified" — the owner is who decides the label and who is asked when it turns out to be
     * wrong. The drawer answered it with a uuid. Resolved here rather than in the SPA because the
     * directory endpoint needs `employee.read`, which an `information_asset.read` holder is not
     * required to have.
     */
    const names = await resolveEmployeeNames(this.db, [
      ...page.rows.map((r) => r.ownerId),
      ...page.rows.map((r) => r.custodianId),
    ]);
    return {
      ...page,
      rows: page.rows.map((r) => ({
        ...r,
        ownerName: nameOf(names, r.ownerId),
        custodianName: nameOf(names, r.custodianId),
      })),
    };
  }

  /**
   * Correct the descriptive fields and the CIA rating.
   *
   * `classification` is not among them — that is `reclassify` and `declassify`, which write history
   * and, downwards, need a different permission. Routing it through here would make both optional.
   */
  async update(id: string, input: UpdateAssetInput, actor: Actor): Promise<InformationAsset> {
    const before = await this.getById(id);
    this.assertNotRetired(before);
    // Validated against the row AS IT WILL BE: a patch that only moves `personalData` still has to
    // be judged against the classification already stored, and vice versa.
    this.assertCoherent({
      classification: before.classification,
      confidentiality: input.confidentiality ?? before.confidentiality,
      integrity: input.integrity ?? before.integrity,
      availability: input.availability ?? before.availability,
      personalData: input.personalData ?? before.personalData,
      retentionMonths:
        input.retentionMonths === undefined ? before.retentionMonths : input.retentionMonths,
    });

    return this.db.transaction(async (tx) => {
      const after = await this.repo.update(id, input, tx);
      await this.trail.record(AUDIT_ACTION.INFORMATION_ASSET_UPDATED, id, actor, tx, {
        before: {
          name: before.name,
          ownerId: before.ownerId,
          confidentiality: before.confidentiality,
          integrity: before.integrity,
          availability: before.availability,
          personalData: before.personalData,
        },
        after: {
          name: after!.name,
          ownerId: after!.ownerId,
          confidentiality: after!.confidentiality,
          integrity: after!.integrity,
          availability: after!.availability,
          personalData: after!.personalData,
        },
      });
      return after!;
    });
  }

  /**
   * RAISE the classification, or move it sideways to another level of the same rank.
   *
   * Refuses a reduction, pointing at `declassify`. The refusal is not merely a routing convenience:
   * this method is reachable by anybody holding `information_asset.manage`, and without it that
   * permission would silently include the power to declassify.
   */
  async reclassify(
    id: string,
    to: InformationClassification,
    reason: string,
    actor: Actor,
  ): Promise<InformationAsset> {
    return this.applyClassification(id, to, reason, actor, { allowReduction: false });
  }

  /**
   * LOWER the classification.
   *
   * Only reachable through the route guarded by `information_asset.declassify`. Raising is allowed
   * here too — a holder of the stricter permission being unable to do the lesser thing would just
   * mean two calls to achieve one change.
   */
  async declassify(
    id: string,
    to: InformationClassification,
    reason: string,
    actor: Actor,
  ): Promise<InformationAsset> {
    return this.applyClassification(id, to, reason, actor, { allowReduction: true });
  }

  /** Stamp a review as having happened, and optionally move the next one. */
  async markReviewed(
    id: string,
    reviewDueOn: string | null,
    actor: Actor,
  ): Promise<InformationAsset> {
    await this.getById(id);

    return this.db.transaction(async (tx) => {
      const reviewed = await this.repo.markReviewed(id, reviewDueOn, tx);
      if (!reviewed) {
        throw new ConflictException(
          ErrorCodes.NOT_FOUND,
          'That asset disappeared while being reviewed',
        );
      }
      await this.trail.record(AUDIT_ACTION.INFORMATION_ASSET_REVIEWED, id, actor, tx, {
        after: { lastReviewedAt: reviewed.lastReviewedAt, reviewDueOn: reviewed.reviewDueOn },
      });
      return reviewed;
    });
  }

  /** Retire an asset. Its history and device links stay — they are the historical evidence. */
  async retire(id: string, actor: Actor): Promise<InformationAsset> {
    await this.getById(id);

    return this.db.transaction(async (tx) => {
      const retired = await this.repo.retire(id, tx);
      if (!retired) {
        throw new PreconditionFailedException(
          ErrorCodes.INFORMATION_ASSET_RETIRED,
          'That information asset is already retired',
        );
      }
      await this.trail.record(AUDIT_ACTION.INFORMATION_ASSET_RETIRED, id, actor, tx, {
        after: { retiredAt: retired.retiredAt },
      });
      return retired;
    });
  }

  // ── Classification history ───────────────────────────────────────────────────

  async listChanges(id: string): Promise<ClassificationChange[]> {
    await this.getById(id);
    return this.repo.listChanges(id);
  }

  // ── Devices ──────────────────────────────────────────────────────────────────

  async linkDevice(id: string, deviceAssetId: string, actor: Actor): Promise<void> {
    const asset = await this.getById(id);
    this.assertNotRetired(asset);

    await this.db.transaction(async (tx) => {
      await this.repo.linkDevice(id, deviceAssetId, actor.sub, tx);
      await this.trail.record(AUDIT_ACTION.INFORMATION_ASSET_DEVICE_LINKED, id, actor, tx, {
        after: { deviceAssetId, classification: asset.classification },
      });
    });
  }

  async unlinkDevice(id: string, deviceAssetId: string, actor: Actor): Promise<void> {
    await this.getById(id);

    await this.db.transaction(async (tx) => {
      const removed = await this.repo.unlinkDevice(id, deviceAssetId, tx);
      if (!removed) {
        throw new NotFoundException(
          ErrorCodes.NOT_FOUND,
          'That device is not recorded as holding this information asset',
        );
      }
      await this.trail.record(AUDIT_ACTION.INFORMATION_ASSET_DEVICE_UNLINKED, id, actor, tx, {
        before: { deviceAssetId },
      });
    });
  }

  async listDevices(id: string) {
    await this.getById(id);
    return this.repo.listDevicesFor(id);
  }

  // ── Reports ──────────────────────────────────────────────────────────────────

  /**
   * What one device holds, worst first — the question asked when a laptop goes missing.
   *
   * Takes a DEVICE id from `assets.assets`. Deliberately not validated against that table: an empty
   * list is the honest answer for a device that holds nothing registered, and a 404 here would make
   * "nothing was on it" indistinguishable from "that device is not in the inventory" for the caller
   * who most needs the difference to be obvious.
   */
  async holdingsOnDevice(deviceAssetId: string): Promise<DeviceHolding[]> {
    return this.repo.holdingsOnDevice(deviceAssetId);
  }

  /** The register by label — what we hold, and how much of it is personal data. */
  async classificationSummary(): Promise<ClassificationSummaryLine[]> {
    return this.repo.classificationSummary();
  }

  // ── Shared internals ─────────────────────────────────────────────────────────

  /**
   * The one implementation behind `reclassify` and `declassify`.
   *
   * Private, and the flag is set by which public method was called rather than by the caller: a
   * boolean parameter on a public API is how the stricter path eventually gets `true` passed to it by
   * somebody who only wanted the change to go through.
   */
  private async applyClassification(
    id: string,
    to: InformationClassification,
    reason: string,
    actor: Actor,
    opts: { allowReduction: boolean },
  ): Promise<InformationAsset> {
    const before = await this.getById(id);
    this.assertNotRetired(before);

    const from = before.classification;
    if (from === to) {
      // `ck_asset_classification_history_change` in words: a change that changes nothing would put a
      // row in the one place that has to stay readable.
      throw new PreconditionFailedException(
        ErrorCodes.INFORMATION_ASSET_NOT_RECLASSIFIED,
        `That asset is already classified '${to}'`,
      );
    }

    const ranks = await this.rankMap();
    const isReduction = ranks[to] < ranks[from];
    if (isReduction && !opts.allowReduction) {
      throw new PreconditionFailedException(
        ErrorCodes.INFORMATION_ASSET_DECLASSIFY_REQUIRED,
        `Lowering the classification from '${from}' to '${to}' reduces protection, so it goes ` +
          'through declassification and needs the `information_asset.declassify` permission',
      );
    }

    // The new label has to survive the same rules as the old one. Reclassifying an asset that holds
    // personal data down to `internal` is the case this catches, and it is the whole reason
    // declassification is a separate act.
    this.assertCoherent({
      classification: to,
      confidentiality: before.confidentiality,
      integrity: before.integrity,
      availability: before.availability,
      personalData: before.personalData,
      retentionMonths: before.retentionMonths,
    });

    return this.db.transaction(async (tx) => {
      const after = await this.repo.reclassify(id, from, to, tx);
      if (!after) {
        // The guarded WHERE found nothing, so somebody else moved it first. Refusing is right: the
        // reason recorded below was written about a transition that no longer describes reality.
        throw new ConflictException(
          ErrorCodes.INFORMATION_ASSET_NOT_RECLASSIFIED,
          `That asset was no longer classified '${from}' — reclassify it again from its current level`,
        );
      }
      await this.repo.appendChange(
        id,
        { fromLevel: from, toLevel: to, reason, changedBy: actor.sub },
        tx,
      );
      await this.trail.record(
        isReduction
          ? AUDIT_ACTION.INFORMATION_ASSET_DECLASSIFIED
          : AUDIT_ACTION.INFORMATION_ASSET_RECLASSIFIED,
        id,
        actor,
        tx,
        { before: { classification: from }, after: { classification: to, reason } },
      );
      return after;
    });
  }

  /**
   * Every row-level CHECK on `isms.information_assets`, stated once, against the row as it will be.
   *
   * Called by `register`, `update` and `applyClassification`. One function rather than three
   * scattered guards because the rules relate the columns to each other: whichever column a caller is
   * moving, the same tuple has to hold afterwards.
   */
  private assertCoherent(row: {
    classification: InformationClassification;
    confidentiality: number;
    integrity: number;
    availability: number;
    personalData: boolean;
    retentionMonths: number | null;
  }): void {
    for (const [what, value] of [
      ['confidentiality', row.confidentiality],
      ['integrity', row.integrity],
      ['availability', row.availability],
    ] as const) {
      if (!isRating(value)) {
        throw new PreconditionFailedException(
          ErrorCodes.INFORMATION_ASSET_INVALID_RATING,
          `${what} must be a whole number between ${RATING_MIN} and ${RATING_MAX}, got ${value}`,
        );
      }
    }

    if (row.retentionMonths !== null && row.retentionMonths <= 0) {
      throw new PreconditionFailedException(
        ErrorCodes.INFORMATION_ASSET_INVALID_RATING,
        'A retention period of zero months is not a retention rule — leave it unset instead',
      );
    }

    // Only the extremes are constrained; see the migration for why the middle of the scale is free.
    if (row.classification === 'public' && row.confidentiality !== RATING_MIN) {
      throw new PreconditionFailedException(
        ErrorCodes.INFORMATION_ASSET_CLASSIFICATION_MISMATCH,
        `A 'public' asset cannot have a confidentiality rating of ${row.confidentiality} — ` +
          'public means there is nothing to protect',
      );
    }
    if (row.classification === 'restricted' && row.confidentiality < RATING_MAX - 1) {
      throw new PreconditionFailedException(
        ErrorCodes.INFORMATION_ASSET_CLASSIFICATION_MISMATCH,
        `A 'restricted' asset needs a confidentiality rating of at least ${RATING_MAX - 1}, got ` +
          `${row.confidentiality} — the label was applied without the assessment agreeing`,
      );
    }

    if (row.personalData && !PERSONAL_DATA_LEVELS.includes(row.classification)) {
      throw new PreconditionFailedException(
        ErrorCodes.INFORMATION_ASSET_PERSONAL_DATA_EXPOSED,
        `Personal data cannot be classified '${row.classification}' — it must be at least ` +
          `'${PERSONAL_DATA_LEVELS[0]}'`,
      );
    }
  }

  private assertNotRetired(asset: InformationAsset): void {
    if (asset.retiredAt) {
      throw new PreconditionFailedException(
        ErrorCodes.INFORMATION_ASSET_RETIRED,
        `Information asset ${asset.reference} is retired and accepts no further changes`,
      );
    }
  }

  /**
   * Label → rank, read from the database.
   *
   * Not cached and not hard-coded. The table has four rows, so a read per reclassification is not
   * the cost worth optimising, and a stale copy of the ranking is exactly what would make a
   * reduction in protection look like an increase.
   */
  private async rankMap(): Promise<Record<InformationClassification, number>> {
    const levels = await this.repo.listLevels();
    return Object.fromEntries(levels.map((l) => [l.code, l.rank])) as Record<
      InformationClassification,
      number
    >;
  }
}
