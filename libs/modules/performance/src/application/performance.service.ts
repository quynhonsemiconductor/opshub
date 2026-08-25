import { Inject, Injectable } from '@nestjs/common';
import {
  ConflictException,
  ErrorCodes,
  InjectDrizzle,
  nameOf,
  resolveEmployeeNames,
  NotFoundException,
  PreconditionFailedException,
  RequestEngine,
  type DbExecutor,
  type DrizzleDB,
} from '@platform';
import { REQUEST_TYPE, type Actor } from '@shared-kernel';
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE,
  AuditService,
  type ResourceAuditTrail,
} from '@modules/audit';
import { PositionsService } from '@modules/positions';
import {
  PERFORMANCE_REPOSITORY,
  SETTLED_REVIEW_STATUSES,
  type IPerformanceRepository,
  type PerformanceCycleStatusFilter,
} from '../domain/ports/performance.repository';
import type {
  CoverageGap,
  CreateCycleInput,
  CycleProgress,
  PerformanceCycle,
  PerformanceGoal,
  PerformanceRatingLevel,
  PerformanceReview,
  RateReviewInput,
  ReviewFilters,
  SetGoalInput,
} from '../domain/performance.types';
import type { PerformanceReviewPayload } from './performance-review.type-def';

/** The share of the judgement a review's goals must add up to before it can be submitted. */
const REQUIRED_WEIGHT_TOTAL = 100;

/**
 * Goal weights are `numeric(5,2)`, so a set can legitimately total 99.99 or 100.01 in float
 * arithmetic while being exactly 100 in the column. A cent of tolerance accepts what the database
 * would store as correct and still refuses the real mistake, which is a set totalling 90 or 110.
 */
const WEIGHT_TOLERANCE = 0.01;

/**
 * Performance reviews: the cycle, the review, and the goals it is judged against.
 *
 * WHAT THIS SERVICE OWNS THAT THE DATABASE CANNOT
 *
 * 1. GOAL WEIGHTS TOTAL 100, AND EVERY GOAL IS RATED. A sum and a count across rows, so no
 *    row-level CHECK can see them. Enforced when the review is SENT FOR APPROVAL, which is the
 *    moment the weights stop being a draft — enforcing it earlier would make it impossible to add
 *    the first goal, since one goal at 40% is a legal step towards a complete set.
 *
 * 2. THE DEVELOPMENT-PLAN GATE. `requires_development_plan` lives on the rating scale and the plan
 *    on the review: two tables, so a CHECK cannot compare them. A poor rating with nothing attached
 *    is a complaint about somebody rather than a decision about what happens next.
 *
 * 3. ONLY THE ASSIGNED REVIEWER WRITES THE REVIEW. Naming the reviewer on the row is what makes
 *    rating a scope rule rather than a permission — a manager needs no code to write the review they
 *    were given, and `performance.manage` does not let anybody write somebody else's.
 *
 * 4. THE EMPLOYEE NEVER SIGNS OFF THEIR OWN RATING. The engine keeps the SUBMITTER out of their own
 *    chain, which covers the reviewer; the subject is a different person and needs its own refusal,
 *    or anybody holding `performance.approve` could approve their own review. That check lives in
 *    the type def, inside the approval transaction, because that is where the approver is known.
 *
 * 5. A CYCLE DOES NOT CLOSE OVER REVIEWS IN FLIGHT. A count across rows. Closing regardless would
 *    make the coverage report claim a cycle finished that nobody finished.
 *
 * WHAT THE DATABASE OWNS, AND WHY IT IS NOT HERE AS WELL
 *
 * Nobody reviews themselves (`ck_review_reviewer_not_employee`), one review per employee per cycle
 * (`ux_review_cycle_employee`), a shared review has a rating, and the three timestamp pairs. Each is
 * a fact about a single row, so the table is the right place — but each is ALSO restated as a coded
 * refusal below, because a raw constraint violation reaches the caller as a 500 with no code.
 */
/**
 * A review with both of the people it names resolved.
 *
 * A type rather than two optional fields on `PerformanceReview`: the domain row genuinely does not
 * have them, and making them optional there would let a read path forget to resolve and still typecheck.
 */
export type NamedReview = PerformanceReview & {
  employeeName: string | null;
  reviewerName: string | null;
};

@Injectable()
export class PerformanceService {
  private readonly cycleTrail: ResourceAuditTrail;
  private readonly reviewTrail: ResourceAuditTrail;

  constructor(
    @Inject(PERFORMANCE_REPOSITORY) private readonly repo: IPerformanceRepository,
    @InjectDrizzle() private readonly db: DrizzleDB,
    private readonly audit: AuditService,
    private readonly engine: RequestEngine,
    private readonly positions: PositionsService,
  ) {
    this.cycleTrail = audit.forResource(AUDIT_RESOURCE.PERFORMANCE_CYCLE);
    this.reviewTrail = audit.forResource(AUDIT_RESOURCE.PERFORMANCE_REVIEW);
  }

  // ── The rating scale ───────────────────────────────────────────────────────

  /**
   * The scale, worst first.
   *
   * Read per call rather than cached: five rows, and a stale `requires_development_plan` is exactly
   * what would let a poor rating be shared with no plan attached.
   */
  async listRatingScale(): Promise<PerformanceRatingLevel[]> {
    return this.repo.listRatingScale();
  }

  // ── Cycles ─────────────────────────────────────────────────────────────────

  async createCycle(
    input: Omit<CreateCycleInput, 'createdBy'>,
    actor: Actor,
  ): Promise<PerformanceCycle> {
    if (input.periodEnd < input.periodStart) {
      throw new PreconditionFailedException(
        ErrorCodes.PRECONDITION_FAILED,
        'periodEnd must be on or after periodStart',
      );
    }
    if (input.reviewDue < input.periodEnd) {
      throw new PreconditionFailedException(
        ErrorCodes.PRECONDITION_FAILED,
        'reviewDue must be on or after periodEnd — a period cannot be reviewed before it ends',
      );
    }
    if (input.selfAssessmentDue && input.selfAssessmentDue > input.reviewDue) {
      throw new PreconditionFailedException(
        ErrorCodes.PRECONDITION_FAILED,
        'selfAssessmentDue must be on or before reviewDue',
      );
    }
    const clash = await this.repo.findCycleByReference(input.reference);
    if (clash) {
      throw new ConflictException(
        ErrorCodes.CONFLICT,
        `A cycle with reference ${input.reference} already exists`,
      );
    }

    return this.db.transaction(async (tx) => {
      const cycle = await this.repo.createCycle({ ...input, createdBy: actor.sub }, tx);
      await this.cycleTrail.record(AUDIT_ACTION.PERFORMANCE_CYCLE_CREATED, cycle.id, actor, tx, {
        after: {
          reference: cycle.reference,
          periodStart: cycle.periodStart,
          periodEnd: cycle.periodEnd,
        },
      });
      return cycle;
    });
  }

  async listCycles(
    status: PerformanceCycleStatusFilter,
    limit: number,
    offset: number,
  ): Promise<{ rows: PerformanceCycle[]; total: number }> {
    return this.repo.listCycles(status, limit, offset);
  }

  async getCycle(id: string): Promise<PerformanceCycle> {
    return this.mustFindCycle(id);
  }

  async openCycle(id: string, actor: Actor): Promise<PerformanceCycle> {
    return this.db.transaction(async (tx) => {
      const opened = await this.repo.openCycle(id, tx);
      if (!opened) {
        // Either it does not exist or it is not a draft. Distinguished so the message is useful.
        const existing = await this.repo.findCycleById(id, tx);
        if (!existing) throw new NotFoundException(ErrorCodes.NOT_FOUND, 'Cycle not found');
        throw new PreconditionFailedException(
          ErrorCodes.PERFORMANCE_REVIEW_NOT_IN_STATE,
          `Only a draft cycle can be opened; this one is ${existing.status}`,
        );
      }
      await this.cycleTrail.record(AUDIT_ACTION.PERFORMANCE_CYCLE_OPENED, id, actor, tx, {
        after: { status: opened.status },
      });
      return opened;
    });
  }

  /**
   * Close a cycle, refusing while any review is still in flight.
   *
   * The count is taken INSIDE the transaction and the update is guarded on `open`, so a review
   * created between the count and the close cannot slip through: the reviews table is read in the
   * same snapshot the close commits in.
   */
  async closeCycle(id: string, actor: Actor): Promise<PerformanceCycle> {
    return this.db.transaction(async (tx) => {
      const cycle = await this.repo.findCycleById(id, tx);
      if (!cycle) throw new NotFoundException(ErrorCodes.NOT_FOUND, 'Cycle not found');

      const unfinished = await this.repo.countUnfinishedReviews(id, tx);
      if (unfinished > 0) {
        throw new PreconditionFailedException(
          ErrorCodes.PERFORMANCE_CYCLE_HAS_OPEN_REVIEWS,
          `${unfinished} review(s) are neither acknowledged nor cancelled. Closing now would report ` +
            `a cycle as finished that nobody finished — see the coverage report for which.`,
        );
      }

      const closed = await this.repo.closeCycle(id, tx);
      if (!closed) {
        throw new PreconditionFailedException(
          ErrorCodes.PERFORMANCE_REVIEW_NOT_IN_STATE,
          `Only an open cycle can be closed; this one is ${cycle.status}`,
        );
      }
      await this.cycleTrail.record(AUDIT_ACTION.PERFORMANCE_CYCLE_CLOSED, id, actor, tx, {
        before: { status: cycle.status },
        after: { status: closed.status },
      });
      return closed;
    });
  }

  async cycleProgress(id: string): Promise<CycleProgress[]> {
    await this.mustFindCycle(id);
    return this.repo.cycleProgress(id);
  }

  async coverageGaps(
    cycleId: string,
    limit: number,
    offset: number,
  ): Promise<{ rows: CoverageGap[]; total: number }> {
    await this.mustFindCycle(cycleId);
    return this.repo.coverageGaps(cycleId, limit, offset);
  }

  // ── Reviews ────────────────────────────────────────────────────────────────

  /**
   * Create the review for one employee in an open cycle.
   *
   * The POSITION IS FROZEN here, read from the employee's current assignment. A review is a
   * judgement about how somebody did in a role, so a transfer afterwards must not restate what the
   * review was about.
   */
  async createReview(
    input: { cycleId: string; employeeId: string; reviewerId: string },
    actor: Actor,
  ): Promise<PerformanceReview> {
    const cycle = await this.mustFindCycle(input.cycleId);
    if (cycle.status !== 'open') {
      throw new PreconditionFailedException(
        ErrorCodes.PERFORMANCE_CYCLE_NOT_OPEN,
        `Reviews can only be created in an open cycle; ${cycle.reference} is ${cycle.status}`,
      );
    }
    if (input.reviewerId === input.employeeId) {
      // Also `ck_review_reviewer_not_employee`. Restated so it is a 412 with a code rather than a
      // 500 from a constraint nobody translated.
      throw new PreconditionFailedException(
        ErrorCodes.PERFORMANCE_SELF_REVIEW,
        'Nobody reviews themselves — that is what the self-assessment on the review is for',
      );
    }
    const existing = await this.repo.findReviewForEmployee(input.cycleId, input.employeeId);
    if (existing) {
      throw new ConflictException(
        ErrorCodes.CONFLICT,
        'That employee already has a review in this cycle',
      );
    }

    const current = await this.positions.currentAssignment(input.employeeId);

    /*
     * WHERE THE REVIEW STARTS depends on whether the cycle HAS a self-assessment step.
     *
     * `selfAssessmentDue` is nullable and the cycle form offers leaving it empty in as many words —
     * "for a cycle with no self-assessment step". But a review was always created in
     * `self_assessment`, and the only way out of that state is the subject submitting one. So those
     * cycles produced reviews that could never be rated: `recordRating` requires `manager_review`, the
     * reviewer was shown no Rate action, and the employee was asked for something the cycle had
     * declared unnecessary. Every review in such a cycle was stuck from the moment it was created.
     */
    const initialStatus = cycle.selfAssessmentDue ? 'self_assessment' : 'manager_review';

    return this.db.transaction(async (tx) => {
      const review = await this.repo.createReview(
        {
          ...input,
          positionId: current?.positionId ?? null,
          createdBy: actor.sub,
          status: initialStatus,
        },
        tx,
      );
      await this.reviewTrail.record(AUDIT_ACTION.PERFORMANCE_REVIEW_CREATED, review.id, actor, tx, {
        after: {
          cycleId: review.cycleId,
          employeeId: review.employeeId,
          reviewerId: review.reviewerId,
          positionId: review.positionId,
        },
      });
      return review;
    });
  }

  async listReviews(
    filters: ReviewFilters,
    limit: number,
    offset: number,
  ): Promise<{ rows: NamedReview[]; total: number }> {
    const page = await this.repo.listReviews(filters, limit, offset);
    /*
     * BOTH names, in one query for the page. A review row names two people and rendered neither: the
     * Employee and Reviewer columns were uuids, so the list could not answer "who reviews whom" —
     * which is the sentence at the top of the screen.
     *
     * One lookup for both, because `resolveEmployeeNames` deduplicates: a manager reviewing eight
     * people appears once in the id list.
     */
    const names = await resolveEmployeeNames(this.db, [
      ...page.rows.map((r) => r.employeeId),
      ...page.rows.map((r) => r.reviewerId),
    ]);
    return {
      ...page,
      rows: page.rows.map((r) => ({
        ...r,
        employeeName: nameOf(names, r.employeeId),
        reviewerName: nameOf(names, r.reviewerId),
      })),
    };
  }

  async getReview(id: string): Promise<NamedReview> {
    const review = await this.mustFindReview(id);
    const names = await resolveEmployeeNames(this.db, [review.employeeId, review.reviewerId]);
    return {
      ...review,
      employeeName: nameOf(names, review.employeeId),
      reviewerName: nameOf(names, review.reviewerId),
    };
  }

  async listGoals(reviewId: string): Promise<PerformanceGoal[]> {
    await this.mustFindReview(reviewId);
    return this.repo.listGoals(reviewId);
  }

  async reassignReviewer(id: string, reviewerId: string, actor: Actor): Promise<PerformanceReview> {
    const review = await this.mustFindReview(id);
    if (reviewerId === review.employeeId) {
      throw new PreconditionFailedException(
        ErrorCodes.PERFORMANCE_SELF_REVIEW,
        'Nobody reviews themselves',
      );
    }
    return this.db.transaction(async (tx) => {
      const updated = await this.repo.reassignReviewer(id, reviewerId, tx);
      if (!updated) {
        throw new PreconditionFailedException(
          ErrorCodes.PERFORMANCE_REVIEW_NOT_IN_STATE,
          `A reviewer can only be changed while the review is being written; this one is ${review.status}`,
        );
      }
      await this.reviewTrail.record(
        AUDIT_ACTION.PERFORMANCE_REVIEW_REVIEWER_CHANGED,
        id,
        actor,
        tx,
        { before: { reviewerId: review.reviewerId }, after: { reviewerId } },
      );
      return updated;
    });
  }

  /** Set or edit a goal. Keyed on (review, title), so re-sending one is an edit, not a duplicate. */
  async setGoal(input: SetGoalInput, actor: Actor): Promise<PerformanceGoal> {
    const review = await this.mustFindReview(input.reviewId);
    this.assertGoalsEditable(review);

    return this.db.transaction(async (tx) => {
      const goal = await this.repo.setGoal(input, tx);
      await this.reviewTrail.record(AUDIT_ACTION.PERFORMANCE_GOAL_SET, review.id, actor, tx, {
        after: { goalId: goal.id, title: goal.title, weight: goal.weight },
      });
      return goal;
    });
  }

  async removeGoal(reviewId: string, goalId: string, actor: Actor): Promise<void> {
    const review = await this.mustFindReview(reviewId);
    this.assertGoalsEditable(review);

    await this.db.transaction(async (tx) => {
      const removed = await this.repo.removeGoal(goalId, tx);
      if (!removed || removed.reviewId !== reviewId) {
        throw new NotFoundException(ErrorCodes.NOT_FOUND, 'Goal not found on this review');
      }
      await this.reviewTrail.record(AUDIT_ACTION.PERFORMANCE_GOAL_REMOVED, reviewId, actor, tx, {
        before: { goalId, title: removed.title, weight: removed.weight },
      });
    });
  }

  /** The employee's own words, and the handover to the reviewer. */
  async submitSelfAssessment(id: string, text: string, actor: Actor): Promise<PerformanceReview> {
    const review = await this.mustFindReview(id);
    return this.db.transaction(async (tx) => {
      const updated = await this.repo.submitSelfAssessment(id, text, tx);
      if (!updated) {
        throw new PreconditionFailedException(
          ErrorCodes.PERFORMANCE_REVIEW_NOT_IN_STATE,
          `A self-assessment can only be submitted while the review is awaiting one; this one is ${review.status}`,
        );
      }
      await this.reviewTrail.record(
        AUDIT_ACTION.PERFORMANCE_SELF_ASSESSMENT_SUBMITTED,
        id,
        actor,
        tx,
        { after: { status: updated.status } },
      );
      return updated;
    });
  }

  /**
   * Record the reviewer's rating. Does NOT submit it — see {@link submitForApproval}.
   *
   * Separate steps deliberately: a rating is drafted, discussed and revised, and a single call that
   * both rated and submitted would put every draft in front of an approver.
   */
  async rate(id: string, input: RateReviewInput, actor: Actor): Promise<PerformanceReview> {
    const review = await this.mustFindReview(id);
    this.assertIsReviewer(review, actor);

    const level = await this.repo.findRatingLevel(input.overallRating);
    if (!level) {
      throw new NotFoundException(ErrorCodes.NOT_FOUND, 'Unknown rating');
    }
    const plan = input.developmentPlan?.trim() ? input.developmentPlan.trim() : null;
    if (level.requiresDevelopmentPlan && !plan) {
      throw new PreconditionFailedException(
        ErrorCodes.PERFORMANCE_DEVELOPMENT_PLAN_REQUIRED,
        `A rating of "${level.label}" requires a development plan: a rating this low with nothing ` +
          `attached to it is a complaint rather than a decision about what happens next.`,
      );
    }

    return this.db.transaction(async (tx) => {
      const updated = await this.repo.recordRating(
        id,
        {
          managerSummary: input.managerSummary,
          overallRating: input.overallRating,
          developmentPlan: plan,
        },
        tx,
      );
      if (!updated) {
        throw new PreconditionFailedException(
          ErrorCodes.PERFORMANCE_REVIEW_NOT_IN_STATE,
          `A review can only be rated while it is with the reviewer; this one is ${review.status}`,
        );
      }

      for (const goal of input.goals ?? []) {
        const rated = await this.repo.rateGoal(
          goal.id,
          id,
          { outcome: goal.outcome ?? null, rating: goal.rating },
          tx,
        );
        if (!rated) {
          throw new NotFoundException(
            ErrorCodes.NOT_FOUND,
            `Goal ${goal.id} not found on this review`,
          );
        }
      }

      await this.reviewTrail.record(AUDIT_ACTION.PERFORMANCE_REVIEW_RATED, id, actor, tx, {
        before: { overallRating: review.overallRating },
        after: { overallRating: updated.overallRating, goalsRated: (input.goals ?? []).length },
      });
      return updated;
    });
  }

  /**
   * Send the rating for calibration sign-off.
   *
   * The two cross-row rules land here, because this is the moment the review stops being a draft:
   * the goals must total 100% of the judgement and every one of them must be graded.
   */
  async submitForApproval(id: string, actor: Actor): Promise<PerformanceReview> {
    const review = await this.mustFindReview(id);
    this.assertIsReviewer(review, actor);
    if (!review.overallRating || !review.managerSummary) {
      throw new PreconditionFailedException(
        ErrorCodes.PERFORMANCE_REVIEW_NOT_IN_STATE,
        'Rate the review before submitting it',
      );
    }

    const goals = await this.repo.listGoals(id);
    this.assertGoalsComplete(goals);

    const payload: PerformanceReviewPayload = {
      reviewId: review.id,
      cycleId: review.cycleId,
      employeeId: review.employeeId,
      reviewerId: review.reviewerId,
      overallRating: review.overallRating,
    };
    const item = await this.engine.submit(REQUEST_TYPE.PERFORMANCE_REVIEW, payload, actor);

    return this.db.transaction(async (tx) => {
      const updated = await this.repo.markPendingApproval(id, item.id, tx);
      if (!updated) {
        throw new PreconditionFailedException(
          ErrorCodes.PERFORMANCE_REVIEW_NOT_IN_STATE,
          `A review can only be submitted from the reviewer's desk; this one is ${review.status}`,
        );
      }
      await this.reviewTrail.record(
        AUDIT_ACTION.PERFORMANCE_REVIEW_SUBMITTED_FOR_APPROVAL,
        id,
        actor,
        tx,
        { after: { status: updated.status, engineRequestId: item.id } },
      );
      return updated;
    });
  }

  /** The employee's confirmation that the review was discussed with them. */
  async acknowledge(id: string, actor: Actor): Promise<PerformanceReview> {
    const review = await this.mustFindReview(id);
    return this.db.transaction(async (tx) => {
      const updated = await this.repo.acknowledge(id, tx);
      if (!updated) {
        throw new PreconditionFailedException(
          ErrorCodes.PERFORMANCE_REVIEW_NOT_IN_STATE,
          `Only a shared review can be acknowledged; this one is ${review.status}`,
        );
      }
      await this.reviewTrail.record(AUDIT_ACTION.PERFORMANCE_REVIEW_ACKNOWLEDGED, id, actor, tx, {
        after: { status: updated.status, acknowledgedAt: updated.acknowledgedAt?.toISOString() },
      });
      return updated;
    });
  }

  /** Withdraw a review — possible until the employee has seen it, and not after. */
  async cancelReview(id: string, reason: string, actor: Actor): Promise<PerformanceReview> {
    const review = await this.mustFindReview(id);
    return this.db.transaction(async (tx) => {
      const updated = await this.repo.cancelReview(id, tx);
      if (!updated) {
        throw new PreconditionFailedException(
          ErrorCodes.PERFORMANCE_REVIEW_SETTLED,
          `A review the employee has already seen cannot be withdrawn; this one is ${review.status}`,
        );
      }
      await this.reviewTrail.record(AUDIT_ACTION.PERFORMANCE_REVIEW_CANCELLED, id, actor, tx, {
        before: { status: review.status },
        after: { status: updated.status, reason },
      });
      return updated;
    });
  }

  // ── Called by the request type def, inside the approval transaction ─────────

  /** The engine approved the calibration: the employee may now see it. */
  async applyApproval(reviewId: string, approverId: string, tx: DbExecutor): Promise<void> {
    const shared = await this.repo.markShared(reviewId, approverId, tx);
    if (!shared) {
      throw new PreconditionFailedException(
        ErrorCodes.PERFORMANCE_REVIEW_NOT_IN_STATE,
        'That review is no longer awaiting approval',
      );
    }
    await this.audit.record(
      {
        actorId: approverId,
        actorEmail: null,
        action: AUDIT_ACTION.PERFORMANCE_REVIEW_APPROVED,
        resourceType: AUDIT_RESOURCE.PERFORMANCE_REVIEW,
        resourceId: reviewId,
        metadata: { status: shared.status },
      },
      tx,
    );
  }

  /** The approver sent it back, or the request expired: the reviewer has it again. */
  async applyReturn(
    reviewId: string,
    actorId: string,
    reason: 'rejected' | 'expired',
    tx: DbExecutor,
  ): Promise<void> {
    const returned = await this.repo.returnToReviewer(reviewId, tx);
    // Not an error when nothing matched: an expiry firing after a decision is a race the engine
    // wins either way, and there is nothing to correct.
    if (!returned) return;
    await this.audit.record(
      {
        actorId,
        actorEmail: null,
        action: AUDIT_ACTION.PERFORMANCE_REVIEW_RETURNED,
        resourceType: AUDIT_RESOURCE.PERFORMANCE_REVIEW,
        resourceId: reviewId,
        metadata: { reason, status: returned.status },
      },
      tx,
    );
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async mustFindCycle(id: string): Promise<PerformanceCycle> {
    const cycle = await this.repo.findCycleById(id);
    if (!cycle) throw new NotFoundException(ErrorCodes.NOT_FOUND, 'Cycle not found');
    return cycle;
  }

  private async mustFindReview(id: string): Promise<PerformanceReview> {
    const review = await this.repo.findReviewById(id);
    if (!review) throw new NotFoundException(ErrorCodes.NOT_FOUND, 'Review not found');
    return review;
  }

  /**
   * Only the assigned reviewer writes the review.
   *
   * A scope rule and not a permission: the reviewer is named on the row, so a manager needs no code
   * to write the review they were given, and nobody — `performance.manage` included — writes
   * somebody else's judgement in their name.
   */
  private assertIsReviewer(review: PerformanceReview, actor: Actor): void {
    if (review.reviewerId !== actor.sub) {
      throw new PreconditionFailedException(
        ErrorCodes.PERFORMANCE_NOT_THE_REVIEWER,
        'Only the assigned reviewer may write this review',
      );
    }
  }

  /** Goals are agreed while the review is being written, and frozen once it is submitted. */
  private assertGoalsEditable(review: PerformanceReview): void {
    if (SETTLED_REVIEW_STATUSES.includes(review.status)) {
      throw new ConflictException(
        ErrorCodes.PERFORMANCE_REVIEW_SETTLED,
        `This review is ${review.status}, so its goals accept no changes`,
      );
    }
    if (review.status !== 'self_assessment' && review.status !== 'manager_review') {
      throw new PreconditionFailedException(
        ErrorCodes.PERFORMANCE_REVIEW_NOT_IN_STATE,
        `Goals can only change while the review is being written; this one is ${review.status}. ` +
          `Changing what somebody was judged against after they were judged is not an edit.`,
      );
    }
  }

  /**
   * The goals must be a complete, graded set.
   *
   * A review with no goals at all is allowed on purpose: the first cycle an organisation runs has
   * nobody's goals recorded from the year before, and refusing every review for that reason would
   * make the feature unusable exactly when it is introduced. What is refused is a PARTIAL set —
   * weights that do not add up, or a goal nobody graded — because that is a review whose overall
   * rating cannot be traced to anything.
   */
  private assertGoalsComplete(goals: PerformanceGoal[]): void {
    if (goals.length === 0) return;

    const total = goals.reduce((sum, g) => sum + Number(g.weight), 0);
    if (Math.abs(total - REQUIRED_WEIGHT_TOTAL) > WEIGHT_TOLERANCE) {
      throw new PreconditionFailedException(
        ErrorCodes.PERFORMANCE_GOAL_WEIGHTS_INVALID,
        `The goals carry ${total}% of the judgement, not ${REQUIRED_WEIGHT_TOTAL}%. Adjust the ` +
          `weights so the overall rating can be traced to them.`,
      );
    }

    const ungraded = goals.filter((g) => g.rating === null);
    if (ungraded.length > 0) {
      throw new PreconditionFailedException(
        ErrorCodes.PERFORMANCE_GOAL_WEIGHTS_INVALID,
        `${ungraded.length} goal(s) have no grade: ${ungraded.map((g) => g.title).join(', ')}. An ` +
          `overall rating over ungraded goals is a number with nothing behind it.`,
      );
    }
  }
}
