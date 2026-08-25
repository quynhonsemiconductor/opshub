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
import { today, type Actor, REPORT_ROW_LIMIT } from '@shared-kernel';
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE,
  AuditService,
  type AuditAction,
  type ResourceAuditTrail,
} from '@modules/audit';
import { ControlService, VendorService } from '@modules/isms';
import {
  MANAGEMENT_REVIEW_REPOSITORY,
  type IManagementReviewRepository,
} from '../domain/ports/qms.repository';
import { NonconformanceService } from './nonconformance.service';
import { InternalAuditService } from './internal-audit.service';
import {
  isSettledAction,
  isSettledReview,
} from '../infrastructure/persistence/management-review.drizzle-repository';
import type {
  ActionFilters,
  CarriedForwardAction,
  ManagementReview,
  ManagementReviewAction,
  ManagementReviewStatus,
  RaiseActionInput,
  ReviewAgenda,
  ReviewActionStatus,
  ReviewFilters,
  ScheduleReviewInput,
  UpdateActionInput,
  UpdateReviewInput,
} from '../domain/management-review.types';

/**
 * The review lifecycle.
 *
 * `held` and `closed` are separate for the same reason an audit's `reported` and `closed` are: §9.3.3
 * requires documented outputs, so a meeting that happened and whose minutes were never issued is not a
 * completed review. `cancelled` is reachable only from `scheduled` — once a review has been held its
 * inputs are frozen and its actions raised, and none of that is cancellable.
 */
const ALLOWED_TRANSITIONS: Record<ManagementReviewStatus, readonly ManagementReviewStatus[]> = {
  scheduled: ['held', 'cancelled'],
  held: ['closed'],
  closed: [],
  cancelled: [],
};

/** How many rows of any one input the agenda names. Enough to act on, not a data export. */
const AGENDA_SAMPLE = 10;
/**
 * How many carried-forward actions the agenda carries. §9.3.2(a) wants all of them, within reason.
 *
 * The same ceiling every other report uses, by reference rather than by coincidence: two independent 200s
 * are two numbers that drift apart the first time somebody tunes one.
 */
const CARRIED_FORWARD_LIMIT = REPORT_ROW_LIMIT;

/**
 * Management reviews — ISO 9001 §9.3.
 *
 * WHAT THIS SERVICE OWNS THAT THE DATABASE CANNOT
 *
 * 1. THE AGENDA IS COMPOSED FROM THE OTHER REGISTERS. §9.3.2 lists what a review must consider, and
 *    every item is something another register already answers. This service asks them; it stores no
 *    copy, because a second copy of "how many findings are overdue" disagrees with the register within
 *    a day.
 *
 * 2. HOLDING A REVIEW FREEZES THAT AGENDA. Minutes have to show what the numbers WERE on the day; a
 *    live re-read would silently turn "eleven overdue" into "three" once the backlog cleared, and the
 *    decision recorded beside it would stop making sense. No API accepts `inputs` — the same rule that
 *    keeps risk scores generated and vendor review dates computed.
 *
 * 3. REVIEWS ARE HELD IN ORDER. §9.3.2(a) asks for the status of actions from PREVIOUS reviews, which
 *    only means something if "previous" is settled. A review cannot be held while one scheduled before
 *    it is still outstanding — a statement about another row, so no CHECK can hold it.
 *
 * 4. A CLOSED REVIEW ACCEPTS NO NEW ACTIONS. An action added after the minutes are issued is an output
 *    those minutes do not contain.
 */
@Injectable()
export class ManagementReviewService {
  private readonly trail: ResourceAuditTrail;
  private readonly actionTrail: ResourceAuditTrail;

  constructor(
    @Inject(MANAGEMENT_REVIEW_REPOSITORY) private readonly repo: IManagementReviewRepository,
    private readonly nonconformances: NonconformanceService,
    private readonly audits: InternalAuditService,
    private readonly vendors: VendorService,
    private readonly controls: ControlService,
    @InjectDrizzle() private readonly db: DrizzleDB,
    audit: AuditService,
  ) {
    this.trail = audit.forResource(AUDIT_RESOURCE.MANAGEMENT_REVIEW);
    this.actionTrail = audit.forResource(AUDIT_RESOURCE.REVIEW_ACTION);
  }

  // ── The agenda ───────────────────────────────────────────────────────────────

  /**
   * Assemble the §9.3.2 inputs live.
   *
   * COUNTS AND REFERENCES ONLY — see `ReviewAgenda`. The clause asks for information on performance and
   * trends, which is an aggregate; returning the registers' rows here would make this a way around
   * their own permissions.
   *
   * `excludeReviewId` is the review being prepared, so its own actions are not offered back to it as
   * history it should be reviewing.
   */
  async assembleAgenda(excludeReviewId: string | null): Promise<ReviewAgenda> {
    // Asked in parallel: five independent registers, and a review agenda that took five sequential
    // round trips would be the slowest screen in the application for no reason.
    const [
      previousActions,
      containmentOverdue,
      recurrence,
      unlinkedFindings,
      reviewGaps,
      criticalWithoutRisk,
      unassessedSpend,
      untreatedRisks,
    ] = await Promise.all([
      this.repo.carriedForward(excludeReviewId, CARRIED_FORWARD_LIMIT),
      this.nonconformances.containmentOverdue(),
      this.nonconformances.recurrenceSignals(),
      this.audits.unlinkedFindings(),
      this.vendors.reviewGaps(),
      this.vendors.criticalWithoutRisk(),
      this.vendors.unassessedSpend(),
      this.controls.untreatedRisks(),
    ]);

    return {
      previousActions,
      nonconformities: {
        containmentOverdue: containmentOverdue.length,
        overdueReferences: containmentOverdue.slice(0, AGENDA_SAMPLE).map((f) => f.reference),
        recurringProcessAreas: recurrence.slice(0, AGENDA_SAMPLE).map((r) => r.processArea),
      },
      audits: {
        findingsNotLinkedToAnAudit: unlinkedFindings.length,
        unlinkedReferences: unlinkedFindings.slice(0, AGENDA_SAMPLE).map((f) => f.reference),
      },
      externalProviders: {
        reviewGaps: reviewGaps.length,
        gapReferences: reviewGaps.slice(0, AGENDA_SAMPLE).map((v) => v.reference),
        criticalWithoutRisk: criticalWithoutRisk.length,
        unassessedSpendLines: unassessedSpend.length,
      },
      risks: {
        untreated: untreatedRisks.length,
        untreatedReferences: untreatedRisks.slice(0, AGENDA_SAMPLE).map((r) => r.reference),
      },
      assembledAt: new Date().toISOString(),
    };
  }

  // ── The programme ────────────────────────────────────────────────────────────

  async schedule(input: ScheduleReviewInput, actor: Actor): Promise<ManagementReview> {
    if (await this.repo.findByReference(input.reference)) {
      throw new ConflictException(
        ErrorCodes.CONFLICT,
        `Management review reference '${input.reference}' already exists`,
      );
    }

    return this.db.transaction(async (tx) => {
      const created = await this.repo.create(input, tx);
      await this.trail.record(AUDIT_ACTION.MANAGEMENT_REVIEW_SCHEDULED, created.id, actor, tx, {
        after: {
          reference: created.reference,
          period: created.period,
          chairId: created.chairId,
          scheduledFor: created.scheduledFor,
        },
      });
      return created;
    });
  }

  async getById(id: string): Promise<ManagementReview> {
    const review = await this.repo.findById(id);
    if (!review) {
      throw new NotFoundException(ErrorCodes.NOT_FOUND, `Management review ${id} not found`);
    }
    return review;
  }

  /**
   * One review with its chair named — the single-record read path.
   *
   * Separate from `getById` rather than folded into it, because that one is the guard every write path
   * calls first (update, hold, close, cancel and `raiseAction`) and none of them render a chair.
   * Widening it would have put a directory query in front of five mutations — including `hold`, which
   * is already the heaviest call in the module because it assembles the whole §9.3.2 agenda.
   */
  async getWithChair(id: string): Promise<ManagementReview & { chairName: string | null }> {
    const review = await this.getById(id);
    const names = await resolveEmployeeNames(this.db, [review.chairId]);
    return { ...review, chairName: nameOf(names, review.chairId) };
  }

  async list(filters: ReviewFilters, limit: number, offset: number) {
    const page = await this.repo.list(filters, limit, offset);
    /*
     * CHAIR NAMES for the whole page, in one query.
     *
     * §9.3 makes the chair the accountable party for the review, and the drawer rendered that as a
     * uuid. The programme screen reads its drawer's subject out of THIS list rather than re-fetching,
     * so this is the resolution the user actually sees.
     */
    const names = await resolveEmployeeNames(
      this.db,
      page.rows.map((r) => r.chairId),
    );
    return {
      ...page,
      rows: page.rows.map((r) => ({ ...r, chairName: nameOf(names, r.chairId) })),
    };
  }

  async update(id: string, input: UpdateReviewInput, actor: Actor): Promise<ManagementReview> {
    const before = await this.getById(id);
    // Only a scheduled review is editable: once held, the title and period label a frozen snapshot.
    if (before.status !== 'scheduled') {
      throw new PreconditionFailedException(
        ErrorCodes.MANAGEMENT_REVIEW_NOT_IN_STATE,
        `${before.reference} is '${before.status}'. Only a scheduled review can be edited — after it ` +
          'is held, its title and period label a snapshot that was frozen under them.',
      );
    }

    return this.db.transaction(async (tx) => {
      const after = await this.repo.update(id, input, tx);
      await this.trail.record(AUDIT_ACTION.MANAGEMENT_REVIEW_UPDATED, id, actor, tx, {
        before: {
          period: before.period,
          chairId: before.chairId,
          scheduledFor: before.scheduledFor,
        },
        after: {
          period: after!.period,
          chairId: after!.chairId,
          scheduledFor: after!.scheduledFor,
        },
      });
      return after!;
    });
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  /**
   * Hold the review, freezing its §9.3.2 inputs.
   *
   * The snapshot is assembled here and written in the same transaction as the transition, so a held
   * review always has one — which is what `ck_mr_held_pair` then guarantees for every reader.
   */
  async hold(id: string, heldOn: string | undefined, actor: Actor): Promise<ManagementReview> {
    const review = await this.getById(id);
    this.assertTransitionAllowed(review, 'held');

    // §9.3.2(a) is only meaningful if "previous" is settled.
    const earlier = await this.repo.earlierOutstanding(review);
    if (earlier) {
      throw new PreconditionFailedException(
        ErrorCodes.MANAGEMENT_REVIEW_OUT_OF_ORDER,
        `${earlier.reference} was scheduled earlier and is still outstanding. Reviews are held in ` +
          'order, because §9.3.2(a) asks this review for the status of actions from PREVIOUS ones.',
      );
    }

    const inputs = await this.assembleAgenda(id);

    return this.move(
      review,
      'held',
      { heldOn: heldOn ?? today(), inputs: inputs as unknown as Record<string, unknown> },
      AUDIT_ACTION.MANAGEMENT_REVIEW_HELD,
      actor,
      { carriedForwardActions: inputs.previousActions.length },
    );
  }

  /** Issue the minutes — §9.3.3's documented output. */
  async close(
    id: string,
    conclusion: string,
    minutesDocumentId: string,
    actor: Actor,
  ): Promise<ManagementReview> {
    const review = await this.getById(id);
    this.assertTransitionAllowed(review, 'closed');
    return this.move(
      review,
      'closed',
      { conclusion, minutesDocumentId, closedAt: new Date() },
      AUDIT_ACTION.MANAGEMENT_REVIEW_CLOSED,
      actor,
      { minutesDocumentId },
    );
  }

  async cancel(id: string, reason: string, actor: Actor): Promise<ManagementReview> {
    const review = await this.getById(id);
    this.assertTransitionAllowed(review, 'cancelled');
    return this.move(
      review,
      'cancelled',
      { cancelReason: reason },
      AUDIT_ACTION.MANAGEMENT_REVIEW_CANCELLED,
      actor,
      { reason },
    );
  }

  // ── Actions (§9.3.3) ─────────────────────────────────────────────────────────

  async raiseAction(
    reviewId: string,
    input: RaiseActionInput,
    actor: Actor,
  ): Promise<ManagementReviewAction> {
    const review = await this.getById(reviewId);
    if (isSettledReview(review.status)) {
      throw new PreconditionFailedException(
        ErrorCodes.MANAGEMENT_REVIEW_SETTLED,
        `${review.reference} is '${review.status}', so it can raise no further actions — one added ` +
          'now is an output its minutes do not contain',
      );
    }

    return this.db.transaction(async (tx) => {
      const action = await this.repo.addAction(reviewId, input, tx);
      await this.actionTrail.record(AUDIT_ACTION.REVIEW_ACTION_RAISED, action.id, actor, tx, {
        after: {
          managementReviewId: reviewId,
          reviewReference: review.reference,
          category: action.category,
          ownerId: action.ownerId,
          dueOn: action.dueOn,
        },
      });
      return action;
    });
  }

  async getAction(id: string): Promise<ManagementReviewAction> {
    const action = await this.repo.findActionById(id);
    if (!action) {
      throw new NotFoundException(ErrorCodes.NOT_FOUND, `Review action ${id} not found`);
    }
    return action;
  }

  async listActions(filters: ActionFilters, limit: number, offset: number) {
    const page = await this.repo.listActions(filters, limit, offset);
    /*
     * OWNER NAMES for the whole page, in one query.
     *
     * §9.3.3 outputs exist to be followed up, and following one up means knowing who to ask. The
     * action card showed the category, the status and the due date but not the person, so the queue
     * could say an action was three weeks overdue without saying overdue on whom.
     *
     * NOT done on `carriedForward` — see that method.
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

  async updateAction(
    id: string,
    input: UpdateActionInput,
    actor: Actor,
  ): Promise<ManagementReviewAction> {
    const before = await this.getAction(id);
    this.assertActionNotSettled(before);

    return this.db.transaction(async (tx) => {
      const after = await this.repo.updateAction(id, input, tx);
      await this.actionTrail.record(AUDIT_ACTION.REVIEW_ACTION_UPDATED, id, actor, tx, {
        before: { category: before.category, ownerId: before.ownerId, dueOn: before.dueOn },
        after: { category: after!.category, ownerId: after!.ownerId, dueOn: after!.dueOn },
      });
      return after!;
    });
  }

  async startAction(id: string, actor: Actor): Promise<ManagementReviewAction> {
    return this.moveAction(id, 'in_progress', {}, AUDIT_ACTION.REVIEW_ACTION_STARTED, actor, {});
  }

  async completeAction(
    id: string,
    outcomeNote: string,
    actor: Actor,
  ): Promise<ManagementReviewAction> {
    return this.moveAction(
      id,
      'completed',
      { completedAt: new Date(), outcomeNote },
      AUDIT_ACTION.REVIEW_ACTION_COMPLETED,
      actor,
      {},
    );
  }

  async cancelAction(id: string, reason: string, actor: Actor): Promise<ManagementReviewAction> {
    return this.moveAction(
      id,
      'cancelled',
      { outcomeNote: reason },
      AUDIT_ACTION.REVIEW_ACTION_CANCELLED,
      actor,
      { reason },
    );
  }

  /**
   * Open actions from earlier reviews — the §9.3.2(a) input, also readable on its own.
   *
   * DELIBERATELY NOT NAME-RESOLVED, unlike `listActions`. These rows are also what `assembleAgenda`
   * freezes onto a held review, and `ReviewAgenda` is narrowed to counts and references on purpose:
   * holding `management_review.read` must not become a way to read the registers' own detail. Adding
   * a directory name here would put employee display names behind that permission and bake them into
   * an immutable snapshot as well. The screen that renders these is a banner of references, not a
   * work queue, so it does not ask who owns them.
   */
  async carriedForward(limit = CARRIED_FORWARD_LIMIT): Promise<CarriedForwardAction[]> {
    return this.repo.carriedForward(null, limit);
  }

  // ── Shared internals ─────────────────────────────────────────────────────────

  private async move(
    review: ManagementReview,
    to: ManagementReviewStatus,
    extra: Parameters<IManagementReviewRepository['transition']>[3],
    action: AuditAction,
    actor: Actor,
    metadata: Record<string, unknown>,
  ): Promise<ManagementReview> {
    const from = review.status;

    return this.db.transaction(async (tx) => {
      const moved = await this.repo.transition(review.id, from, to, extra, tx);
      if (!moved) {
        // Two people holding the same review would otherwise both freeze a snapshot, and only one of
        // them would be the one the minutes cite.
        throw new ConflictException(
          ErrorCodes.MANAGEMENT_REVIEW_NOT_IN_STATE,
          `${review.reference} was no longer '${from}' — read it again and retry`,
        );
      }
      await this.trail.record(action, review.id, actor, tx, {
        before: { status: from },
        after: { status: to, ...metadata },
      });
      return moved;
    });
  }

  private async moveAction(
    id: string,
    to: ReviewActionStatus,
    extra: Parameters<IManagementReviewRepository['transitionAction']>[3],
    auditAction: AuditAction,
    actor: Actor,
    metadata: Record<string, unknown>,
  ): Promise<ManagementReviewAction> {
    const action = await this.getAction(id);
    this.assertActionNotSettled(action);
    if (to === 'in_progress' && action.status !== 'open') {
      throw new PreconditionFailedException(
        ErrorCodes.REVIEW_ACTION_NOT_IN_STATE,
        `That action is '${action.status}', so it cannot be started`,
      );
    }

    const from = action.status;
    return this.db.transaction(async (tx) => {
      const moved = await this.repo.transitionAction(id, from, to, extra, tx);
      if (!moved) {
        throw new ConflictException(
          ErrorCodes.REVIEW_ACTION_NOT_IN_STATE,
          `That action was no longer '${from}' — read it again and retry`,
        );
      }
      await this.actionTrail.record(auditAction, id, actor, tx, {
        before: { status: from },
        after: { status: to, ...metadata },
      });
      return moved;
    });
  }

  private assertTransitionAllowed(review: ManagementReview, to: ManagementReviewStatus): void {
    if (!ALLOWED_TRANSITIONS[review.status].includes(to)) {
      const legal = ALLOWED_TRANSITIONS[review.status];
      throw new PreconditionFailedException(
        ErrorCodes.MANAGEMENT_REVIEW_NOT_IN_STATE,
        `${review.reference} is '${review.status}', which cannot become '${to}'. ` +
          (legal.length === 0
            ? 'That status is terminal.'
            : `Legal next states: ${legal.join(', ')}.`),
      );
    }
  }

  private assertActionNotSettled(action: ManagementReviewAction): void {
    if (isSettledAction(action.status)) {
      throw new PreconditionFailedException(
        ErrorCodes.REVIEW_ACTION_NOT_IN_STATE,
        `That action is '${action.status}' and accepts no further changes`,
      );
    }
  }
}

export { ALLOWED_TRANSITIONS as MANAGEMENT_REVIEW_TRANSITIONS, AGENDA_SAMPLE };
