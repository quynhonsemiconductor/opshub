import { REPORT_ROW_LIMIT } from '@shared-kernel';
import { Inject, Injectable } from '@nestjs/common';
import {
  ConflictException,
  ErrorCodes,
  InjectDrizzle,
  NotFoundException,
  PreconditionFailedException,
  assertDateOrder,
  nameOf,
  resolveEmployeeNames,
  type DrizzleDB,
} from '@platform';
import type { Actor } from '@shared-kernel';
import {
  AUDIT_ACTION,
  type AuditAction,
  AUDIT_RESOURCE,
  AuditService,
  type ResourceAuditTrail,
} from '@modules/audit';
import { VENDOR_REPOSITORY, type IVendorRepository } from '../domain/ports/vendor.repository';
import type { Risk } from '../domain/risk.types';
import type {
  RecordAssessmentInput,
  RegisterVendorInput,
  UnassessedSpend,
  UpdateVendorInput,
  Vendor,
  VendorAssessment,
  VendorAssessmentOutcome,
  VendorCriticalityLevel,
  VendorFilters,
  VendorReviewGap,
  VendorStatus,
} from '../domain/vendor.types';

/**
 * The vendor lifecycle, declared rather than spread through `if` statements.
 *
 * The same shape as the incident module's `ALLOWED_TRANSITIONS`, and for the same reason: the map IS
 * the specification, so a reviewer checks a table instead of tracing branches, and a state with no
 * outgoing entry is terminal by construction.
 *
 * `terminated` has no way back. Restarting with a supplier means assessing them again, which means a
 * new register entry — resurrecting the old row would silently carry its stale assessment forward.
 */
const ALLOWED_TRANSITIONS: Record<VendorStatus, readonly VendorStatus[]> = {
  prospective: ['active', 'terminated'],
  active: ['suspended', 'terminated'],
  suspended: ['active', 'terminated'],
  terminated: [],
};

/**
 * Assessment outcomes that permit reliance on a supplier.
 *
 * `pass_with_conditions` counts: the conditions are recorded and tracked, and refusing to go live on
 * a conditional pass is how people learn to record an unconditional one instead.
 */
const PASSING_OUTCOMES: readonly VendorAssessmentOutcome[] = ['pass', 'pass_with_conditions'];

/**
 * The supplier register: who we depend on, what we checked, and when we last looked.
 *
 * WHAT THIS SERVICE OWNS THAT THE DATABASE CANNOT
 *
 * 1. GOING LIVE NEEDS A CURRENT PASSING ASSESSMENT. This is a statement about the LATEST row of
 *    another table, which no CHECK can express. It is the rule the whole module exists for: a
 *    supplier register that lets you depend on somebody nobody assessed is a list of names.
 *
 * 2. DIRECTION AND LEGALITY. `ALLOWED_TRANSITIONS` plus a guarded `WHERE status = <from>`, so two
 *    people approving the same supplier is Postgres's decision. Going live also needs its own
 *    permission at the route — suspending and terminating do not, because stopping is never the
 *    risky direction.
 *
 * 3. THE REVIEW DATE IS COMPUTED, NEVER SUPPLIED. `review_due_on` is the assessment date plus the
 *    tier's `review_interval_months`, read from `isms.vendor_criticality_levels`. No API accepts it,
 *    for the same reason no API accepts a risk score: a cadence a caller can set is not a cadence.
 *
 * 4. EVERY CHECK IS RESTATED AS A CODED REFUSAL, because a raw constraint violation reaches the
 *    caller as a 500 with no error code. The contract window reuses the shared `assertDateOrder`
 *    guard rather than growing a fourth private copy of it.
 *
 * 5. A TERMINATED VENDOR ACCEPTS NOTHING NEW — no update, no assessment, no risk link. The row stays
 *    because last year's assessments and the risks linked to them are the audit evidence.
 */
@Injectable()
export class VendorService {
  private readonly trail: ResourceAuditTrail;

  constructor(
    @Inject(VENDOR_REPOSITORY) private readonly repo: IVendorRepository,
    @InjectDrizzle() private readonly db: DrizzleDB,
    private readonly audit: AuditService,
  ) {
    // Resource type named ONCE — see `AuditService.forResource`.
    this.trail = audit.forResource(AUDIT_RESOURCE.VENDOR);
  }

  // ── Criticality tiers ────────────────────────────────────────────────────────

  /** The tiers, their ranking, and how often each demands reassessment. */
  async listLevels(): Promise<VendorCriticalityLevel[]> {
    return this.repo.listLevels();
  }

  // ── Register ─────────────────────────────────────────────────────────────────

  async register(input: RegisterVendorInput, actor: Actor): Promise<Vendor> {
    if (await this.repo.findByReference(input.reference)) {
      throw new ConflictException(
        ErrorCodes.CONFLICT,
        `Vendor reference '${input.reference}' is already registered`,
      );
    }
    this.assertContractWindow(input.contractStartsOn, input.contractEndsOn);

    return this.db.transaction(async (tx) => {
      const vendor = await this.repo.create(input, tx);
      await this.trail.record(AUDIT_ACTION.VENDOR_REGISTERED, vendor.id, actor, tx, {
        after: {
          reference: vendor.reference,
          name: vendor.name,
          criticality: vendor.criticality,
          dataProcessor: vendor.dataProcessor,
          ownerId: vendor.ownerId,
        },
      });
      return vendor;
    });
  }

  async getById(id: string): Promise<Vendor> {
    const vendor = await this.repo.findById(id);
    if (!vendor) throw new NotFoundException(ErrorCodes.NOT_FOUND, `Vendor ${id} not found`);
    return vendor;
  }

  /**
   * One supplier, with its owner named — the drawer's read path.
   *
   * Separate from `getById` rather than folded into it, because that one is the guard every write
   * path calls first (update, activate, suspend, reinstate, terminate, assess, link a risk) and none
   * of those render an owner. Widening it would have added a lookup to nine mutations for one screen.
   */
  async getByIdWithOwner(id: string): Promise<Vendor & { ownerName: string | null }> {
    const vendor = await this.getById(id);
    const names = await resolveEmployeeNames(this.db, [vendor.ownerId]);
    return { ...vendor, ownerName: nameOf(names, vendor.ownerId) };
  }

  async list(filters: VendorFilters, limit: number, offset: number) {
    const page = await this.repo.list(filters, limit, offset);
    /*
     * OWNER NAMES for the whole page, in one query.
     *
     * The relationship owner is who gets asked when an assessment falls overdue or a supplier has to
     * be suspended, so it is the field the register is read for once the tier is known — and the
     * drawer answered it with a uuid. Resolved here rather than in the SPA because the directory
     * endpoint needs `employee.read`, which a `vendor.read` holder is not required to have.
     */
    const names = await resolveEmployeeNames(
      this.db,
      page.rows.map((r) => r.ownerId),
    );
    return {
      ...page,
      rows: page.rows.map((r) => ({ ...r, ownerName: nameOf(names, r.ownerId) })),
    };
  }

  async update(id: string, input: UpdateVendorInput, actor: Actor): Promise<Vendor> {
    const before = await this.getById(id);
    this.assertNotTerminated(before);

    // Validated against the row AS IT WILL BE: a patch that moves only one end of the window still
    // has to agree with the end already stored.
    this.assertContractWindow(
      input.contractStartsOn === undefined ? before.contractStartsOn : input.contractStartsOn,
      input.contractEndsOn === undefined ? before.contractEndsOn : input.contractEndsOn,
    );

    // `ck_vendor_processor_agreement` restated. Reachable two ways — setting `dataProcessor` on an
    // already-active vendor, or clearing the agreement from one — so it is checked against the
    // merged row rather than against either field alone.
    const willProcess = input.dataProcessor ?? before.dataProcessor;
    const agreement =
      input.dataProcessingAgreementId === undefined
        ? before.dataProcessingAgreementId
        : input.dataProcessingAgreementId;
    if (before.status === 'active' && willProcess && !agreement) {
      throw new PreconditionFailedException(
        ErrorCodes.VENDOR_AGREEMENT_REQUIRED,
        `${before.reference} is active and processes personal data, so it must keep a recorded ` +
          'data processing agreement — GDPR Article 28(3)',
      );
    }

    return this.db.transaction(async (tx) => {
      const after = await this.repo.update(id, input, tx);
      await this.trail.record(AUDIT_ACTION.VENDOR_UPDATED, id, actor, tx, {
        before: {
          name: before.name,
          criticality: before.criticality,
          ownerId: before.ownerId,
          dataProcessor: before.dataProcessor,
        },
        after: {
          name: after!.name,
          criticality: after!.criticality,
          ownerId: after!.ownerId,
          dataProcessor: after!.dataProcessor,
        },
      });
      return after!;
    });
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  /**
   * Approve a supplier for live use.
   *
   * The act that creates the exposure, so it carries the preconditions: a current passing assessment
   * and, for a processor, a recorded agreement. Guarded by `vendor.approve` at the route.
   */
  async activate(id: string, actor: Actor): Promise<Vendor> {
    const vendor = await this.getById(id);
    this.assertTransitionAllowed(vendor, 'active');

    const latest = await this.repo.latestAssessment(id);
    if (!latest) {
      throw new PreconditionFailedException(
        ErrorCodes.VENDOR_ASSESSMENT_REQUIRED,
        `${vendor.reference} has never been assessed, so it cannot be approved for live use`,
      );
    }
    if (!PASSING_OUTCOMES.includes(latest.outcome)) {
      throw new PreconditionFailedException(
        ErrorCodes.VENDOR_ASSESSMENT_REQUIRED,
        `The most recent assessment of ${vendor.reference} was a '${latest.outcome}' — reassess ` +
          'them before approving live use',
      );
    }
    // Restated in front of `ck_vendor_processor_agreement`, which would otherwise surface as a 500.
    if (vendor.dataProcessor && !vendor.dataProcessingAgreementId) {
      throw new PreconditionFailedException(
        ErrorCodes.VENDOR_AGREEMENT_REQUIRED,
        `${vendor.reference} processes personal data on our behalf, so a data processing agreement ` +
          'must be recorded before it goes live — GDPR Article 28(3)',
      );
    }

    return this.move(vendor, 'active', {}, AUDIT_ACTION.VENDOR_ACTIVATED, actor, {
      assessmentId: latest.id,
      assessmentOutcome: latest.outcome,
    });
  }

  /** Stop relying on a supplier without ending the relationship. */
  async suspend(id: string, reason: string, actor: Actor): Promise<Vendor> {
    const vendor = await this.getById(id);
    this.assertTransitionAllowed(vendor, 'suspended');
    return this.move(vendor, 'suspended', {}, AUDIT_ACTION.VENDOR_SUSPENDED, actor, { reason });
  }

  /**
   * Return a suspended supplier to live use.
   *
   * Deliberately routed through the same preconditions as `activate` rather than being a plain
   * status flip: whatever caused the suspension is exactly the reason to re-check the assessment.
   */
  async reinstate(id: string, actor: Actor): Promise<Vendor> {
    const vendor = await this.getById(id);
    this.assertTransitionAllowed(vendor, 'active');

    const latest = await this.repo.latestAssessment(id);
    if (!latest || !PASSING_OUTCOMES.includes(latest.outcome)) {
      throw new PreconditionFailedException(
        ErrorCodes.VENDOR_ASSESSMENT_REQUIRED,
        `${vendor.reference} cannot be reinstated without a current passing assessment`,
      );
    }
    if (vendor.dataProcessor && !vendor.dataProcessingAgreementId) {
      throw new PreconditionFailedException(
        ErrorCodes.VENDOR_AGREEMENT_REQUIRED,
        `${vendor.reference} processes personal data, so it cannot be reinstated without a ` +
          'recorded data processing agreement',
      );
    }

    return this.move(vendor, 'active', {}, AUDIT_ACTION.VENDOR_REINSTATED, actor, {
      assessmentId: latest.id,
    });
  }

  /** End the relationship. Terminal — see `ALLOWED_TRANSITIONS`. */
  async terminate(id: string, reason: string, actor: Actor): Promise<Vendor> {
    const vendor = await this.getById(id);
    this.assertTransitionAllowed(vendor, 'terminated');

    // `ck_vendor_terminated_pair` demands the date and `ck_vendor_termination_reason` the reason;
    // both are set here rather than left to the caller, so the pair cannot be half-written.
    return this.move(
      vendor,
      'terminated',
      { terminatedAt: new Date(), terminationReason: reason },
      AUDIT_ACTION.VENDOR_TERMINATED,
      actor,
      { reason },
    );
  }

  // ── Assessments ──────────────────────────────────────────────────────────────

  /**
   * Record a due-diligence assessment and move the next review date with it.
   *
   * The two happen together on purpose: an assessment that does not reset the clock leaves the
   * supplier permanently overdue, and a clock reset with no assessment behind it is the thing the
   * cadence exists to prevent.
   */
  async assess(id: string, input: RecordAssessmentInput, actor: Actor): Promise<VendorAssessment> {
    const vendor = await this.getById(id);
    this.assertNotTerminated(vendor);
    this.assertAssessmentComplete(input);

    const assessedAt = input.assessedAt ? new Date(input.assessedAt) : new Date();
    const interval = await this.reviewIntervalFor(vendor.criticality);

    return this.db.transaction(async (tx) => {
      const assessment = await this.repo.appendAssessment(
        id,
        { ...input, assessedBy: actor.sub, assessedAt },
        tx,
      );
      // Computed from the tier, never accepted from the caller, and computed IN SQL — see the
      // repository. Uses the SAME timestamp that was recorded, so the stored due date always agrees
      // with the assessment it came from.
      await this.repo.setReviewDueOn(id, assessedAt, interval, tx);
      await this.trail.record(AUDIT_ACTION.VENDOR_ASSESSED, id, actor, tx, {
        after: {
          assessmentId: assessment.id,
          outcome: assessment.outcome,
          assessedAt: assessment.assessedAt,
        },
      });
      return assessment;
    });
  }

  async listAssessments(id: string): Promise<VendorAssessment[]> {
    await this.getById(id);
    return this.repo.listAssessments(id);
  }

  // ── Vendor ↔ risk ────────────────────────────────────────────────────────────

  async linkRisk(id: string, riskId: string, actor: Actor): Promise<void> {
    const vendor = await this.getById(id);
    this.assertNotTerminated(vendor);

    await this.db.transaction(async (tx) => {
      await this.repo.linkRisk(id, riskId, actor.sub, tx);
      await this.trail.record(AUDIT_ACTION.VENDOR_RISK_LINKED, id, actor, tx, {
        after: { riskId },
      });
    });
  }

  async unlinkRisk(id: string, riskId: string, actor: Actor): Promise<void> {
    await this.getById(id);

    await this.db.transaction(async (tx) => {
      const removed = await this.repo.unlinkRisk(id, riskId, tx);
      if (!removed) {
        throw new NotFoundException(ErrorCodes.NOT_FOUND, 'That risk is not linked to this vendor');
      }
      await this.trail.record(AUDIT_ACTION.VENDOR_RISK_UNLINKED, id, actor, tx, {
        before: { riskId },
      });
    });
  }

  async listRisks(id: string): Promise<Risk[]> {
    await this.getById(id);
    return this.repo.listRisksFor(id);
  }

  // ── Reports ──────────────────────────────────────────────────────────────────

  /** Suppliers never assessed, or past the cadence their tier demands. */
  async reviewGaps(limit = REPORT_ROW_LIMIT): Promise<VendorReviewGap[]> {
    return this.repo.reviewGaps(limit);
  }

  /** Active critical suppliers with no register risk linked — the gap the join exposes. */
  async criticalWithoutRisk(limit = REPORT_ROW_LIMIT): Promise<Vendor[]> {
    return this.repo.criticalWithoutRisk(limit);
  }

  /** Money going to suppliers who are unlinked or unassessed. */
  async unassessedSpend(limit = REPORT_ROW_LIMIT): Promise<UnassessedSpend[]> {
    return this.repo.unassessedSpend(limit);
  }

  // ── Shared internals ─────────────────────────────────────────────────────────

  /**
   * One transition, applied and audited.
   *
   * Every lifecycle method funnels through here, so the guarded update, the lost-race refusal and
   * the audit entry are written once. Four copies of this is how one of them ends up missing the
   * guard.
   */
  private async move(
    vendor: Vendor,
    to: VendorStatus,
    extra: Partial<Pick<Vendor, 'terminatedAt' | 'terminationReason'>>,
    action: AuditAction,
    actor: Actor,
    metadata: Record<string, unknown>,
  ): Promise<Vendor> {
    const from = vendor.status;

    return this.db.transaction(async (tx) => {
      const moved = await this.repo.transition(vendor.id, from, to, extra, tx);
      if (!moved) {
        // The guarded WHERE found nothing, so somebody else moved it first. Refusing is right: the
        // preconditions above were checked against a state that no longer holds.
        throw new ConflictException(
          ErrorCodes.VENDOR_NOT_IN_STATE,
          `${vendor.reference} was no longer '${from}' — read it again and retry`,
        );
      }
      await this.trail.record(action, vendor.id, actor, tx, {
        before: { status: from },
        after: { status: to, ...metadata },
      });
      return moved;
    });
  }

  /** `ALLOWED_TRANSITIONS` as a coded refusal. */
  private assertTransitionAllowed(vendor: Vendor, to: VendorStatus): void {
    if (!ALLOWED_TRANSITIONS[vendor.status].includes(to)) {
      const legal = ALLOWED_TRANSITIONS[vendor.status];
      throw new PreconditionFailedException(
        ErrorCodes.VENDOR_NOT_IN_STATE,
        `${vendor.reference} is '${vendor.status}', which cannot become '${to}'. ` +
          (legal.length === 0
            ? 'That status is terminal — register the supplier again to start over.'
            : `Legal next states: ${legal.join(', ')}.`),
      );
    }
  }

  /** `ck_vendor_assessment_conditions` and `ck_vendor_assessment_failure_findings`, in words. */
  private assertAssessmentComplete(input: RecordAssessmentInput): void {
    if (input.outcome === 'pass_with_conditions' && !hasSubstance(input.conditions)) {
      throw new PreconditionFailedException(
        ErrorCodes.VENDOR_ASSESSMENT_INCOMPLETE,
        'A conditional pass must state the conditions — an unwritten condition is not one',
      );
    }
    if (input.outcome === 'fail' && !hasSubstance(input.findings)) {
      throw new PreconditionFailedException(
        ErrorCodes.VENDOR_ASSESSMENT_INCOMPLETE,
        'A failed assessment must state the findings, or nobody can act on it',
      );
    }
  }

  /** `ck_vendor_contract_window`, via the guard shared with positions, contracts and training. */
  private assertContractWindow(
    from: string | null | undefined,
    to: string | null | undefined,
  ): void {
    if (from && to) {
      assertDateOrder(from, to, ErrorCodes.VENDOR_INVALID_CONTRACT_WINDOW, 'Contract window');
    }
  }

  private assertNotTerminated(vendor: Vendor): void {
    if (vendor.status === 'terminated') {
      throw new PreconditionFailedException(
        ErrorCodes.VENDOR_TERMINATED,
        `${vendor.reference} is terminated and accepts no further changes`,
      );
    }
  }

  /**
   * The review interval for a tier, read from the database.
   *
   * Not cached and not hard-coded. The table has four rows, so a read per assessment is not the cost
   * worth optimising, and a stale copy of the cadence is exactly what would make a supplier look
   * current when policy says otherwise.
   */
  private async reviewIntervalFor(criticality: Vendor['criticality']): Promise<number> {
    const levels = await this.repo.listLevels();
    const level = levels.find((l) => l.code === criticality);
    if (!level) {
      // Unreachable through the FK, which is the point of the FK. Refusing loudly beats computing a
      // due date from a guessed interval.
      throw new PreconditionFailedException(
        ErrorCodes.VENDOR_ASSESSMENT_INCOMPLETE,
        `No criticality tier '${criticality}' is defined, so no review cadence can be applied`,
      );
    }
    return level.reviewIntervalMonths;
  }
}

/** Whether an optional free-text field was actually filled in. Mirrors `length(btrim(x)) >= 10`. */
function hasSubstance(value: string | null | undefined): boolean {
  return (value ?? '').trim().length >= 10;
}

export { ALLOWED_TRANSITIONS, PASSING_OUTCOMES };
