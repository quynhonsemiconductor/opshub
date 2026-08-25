import { Injectable } from '@nestjs/common';
import { and, asc, count, countDistinct, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { InjectDrizzle, type DbExecutor, type DrizzleDB } from '@platform';
import { newId } from '@shared-kernel';
import {
  employeePositions,
  employees,
  performanceCycles,
  performanceGoals,
  performanceRatingScale,
  performanceReviews,
} from '../../../../../../db/schema';
import type {
  IPerformanceRepository,
  PerformanceCycleStatusFilter,
} from '../../domain/ports/performance.repository';
import type {
  CoverageGap,
  CreateCycleInput,
  CreateReviewInput,
  CycleProgress,
  PerformanceCycle,
  PerformanceGoal,
  PerformanceRating,
  PerformanceRatingLevel,
  PerformanceReview,
  ReviewFilters,
  SetGoalInput,
} from '../../domain/performance.types';

/** States in which the review is still being WRITTEN, so the reviewer may still be changed. */
const REASSIGNABLE = ['self_assessment', 'manager_review'] as const;
/** States before the employee has seen anything, so the review can still be withdrawn. */
const CANCELLABLE = ['self_assessment', 'manager_review', 'pending_approval'] as const;

@Injectable()
export class PerformanceDrizzleRepository implements IPerformanceRepository {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  private ex(tx?: DbExecutor): DbExecutor | DrizzleDB {
    return tx ?? this.db;
  }

  // ── The rating scale ───────────────────────────────────────────────────────
  async listRatingScale(tx?: DbExecutor): Promise<PerformanceRatingLevel[]> {
    return (
      this.ex(tx)
        .select({
          code: performanceRatingScale.code,
          rank: performanceRatingScale.rank,
          label: performanceRatingScale.label,
          description: performanceRatingScale.description,
          requiresDevelopmentPlan: performanceRatingScale.requiresDevelopmentPlan,
        })
        .from(performanceRatingScale)
        // By RANK, never by code: the enum's declaration order is not the scale.
        .orderBy(asc(performanceRatingScale.rank))
    );
  }

  async findRatingLevel(
    code: PerformanceRating,
    tx?: DbExecutor,
  ): Promise<PerformanceRatingLevel | null> {
    const [row] = await this.ex(tx)
      .select({
        code: performanceRatingScale.code,
        rank: performanceRatingScale.rank,
        label: performanceRatingScale.label,
        description: performanceRatingScale.description,
        requiresDevelopmentPlan: performanceRatingScale.requiresDevelopmentPlan,
      })
      .from(performanceRatingScale)
      .where(eq(performanceRatingScale.code, code))
      .limit(1);
    return row ?? null;
  }

  // ── Cycles ─────────────────────────────────────────────────────────────────
  async createCycle(input: CreateCycleInput, tx?: DbExecutor): Promise<PerformanceCycle> {
    const [row] = await this.ex(tx)
      .insert(performanceCycles)
      .values({
        id: newId(),
        reference: input.reference,
        name: input.name,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        selfAssessmentDue: input.selfAssessmentDue ?? null,
        reviewDue: input.reviewDue,
        createdBy: input.createdBy,
      })
      .returning();
    return row;
  }

  async findCycleById(id: string, tx?: DbExecutor): Promise<PerformanceCycle | null> {
    const [row] = await this.ex(tx)
      .select()
      .from(performanceCycles)
      .where(eq(performanceCycles.id, id))
      .limit(1);
    return row ?? null;
  }

  async findCycleByReference(reference: string): Promise<PerformanceCycle | null> {
    const [row] = await this.db
      .select()
      .from(performanceCycles)
      .where(eq(performanceCycles.reference, reference))
      .limit(1);
    return row ?? null;
  }

  async listCycles(
    status: PerformanceCycleStatusFilter,
    limit: number,
    offset: number,
  ): Promise<{ rows: PerformanceCycle[]; total: number }> {
    const where = status === 'all' ? undefined : eq(performanceCycles.status, status);
    const [rows, [tally]] = await Promise.all([
      this.db
        .select()
        .from(performanceCycles)
        .where(where)
        // Most recent period first, and within a period the most recently CREATED cycle first.
        //
        // The tiebreaker used to be `asc(id)`, which is oldest-first — and since `id` is a uuidv7, that
        // put a cycle created today BEHIND every other cycle covering the same period. With several
        // hundred cycles sharing one period (each API and browser suite adds some), a freshly created
        // cycle landed on page thirteen, which is indistinguishable from "the create silently failed".
        // `desc(id)` keeps the order total — the ratchet's requirement — and answers the question a
        // reader is actually asking.
        .orderBy(desc(performanceCycles.periodStart), desc(performanceCycles.id))
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(performanceCycles).where(where),
    ]);
    return { rows, total: Number(tally?.total ?? 0) };
  }

  async openCycle(id: string, tx?: DbExecutor): Promise<PerformanceCycle | null> {
    const [row] = await this.ex(tx)
      .update(performanceCycles)
      .set({ status: 'open', openedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(performanceCycles.id, id), eq(performanceCycles.status, 'draft')))
      .returning();
    return row ?? null;
  }

  async closeCycle(id: string, tx?: DbExecutor): Promise<PerformanceCycle | null> {
    const [row] = await this.ex(tx)
      .update(performanceCycles)
      .set({ status: 'closed', closedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(performanceCycles.id, id), eq(performanceCycles.status, 'open')))
      .returning();
    return row ?? null;
  }

  // ── Reviews ────────────────────────────────────────────────────────────────
  async createReview(input: CreateReviewInput, tx?: DbExecutor): Promise<PerformanceReview> {
    const [row] = await this.ex(tx)
      .insert(performanceReviews)
      .values({
        id: newId(),
        cycleId: input.cycleId,
        employeeId: input.employeeId,
        reviewerId: input.reviewerId,
        positionId: input.positionId,
        createdBy: input.createdBy,
        // Explicit, not the column default: see `CreateReviewInput.status`.
        status: input.status,
      })
      .returning();
    return row;
  }

  async findReviewById(id: string, tx?: DbExecutor): Promise<PerformanceReview | null> {
    const [row] = await this.ex(tx)
      .select()
      .from(performanceReviews)
      .where(eq(performanceReviews.id, id))
      .limit(1);
    return row ?? null;
  }

  async findReviewForEmployee(
    cycleId: string,
    employeeId: string,
  ): Promise<PerformanceReview | null> {
    const [row] = await this.db
      .select()
      .from(performanceReviews)
      .where(
        and(eq(performanceReviews.cycleId, cycleId), eq(performanceReviews.employeeId, employeeId)),
      )
      .limit(1);
    return row ?? null;
  }

  async listReviews(
    filters: ReviewFilters,
    limit: number,
    offset: number,
  ): Promise<{ rows: PerformanceReview[]; total: number }> {
    const conditions = [
      filters.cycleId ? eq(performanceReviews.cycleId, filters.cycleId) : undefined,
      filters.employeeId ? eq(performanceReviews.employeeId, filters.employeeId) : undefined,
      filters.reviewerId ? eq(performanceReviews.reviewerId, filters.reviewerId) : undefined,
      filters.status ? eq(performanceReviews.status, filters.status) : undefined,
    ].filter((c): c is Exclude<typeof c, undefined> => c !== undefined);
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [rows, [tally]] = await Promise.all([
      this.db
        .select()
        .from(performanceReviews)
        .where(where)
        // Newest first, `id` last so the order is total.
        .orderBy(desc(performanceReviews.createdAt), asc(performanceReviews.id))
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(performanceReviews).where(where),
    ]);
    return { rows, total: Number(tally?.total ?? 0) };
  }

  async reassignReviewer(
    id: string,
    reviewerId: string,
    tx?: DbExecutor,
  ): Promise<PerformanceReview | null> {
    const [row] = await this.ex(tx)
      .update(performanceReviews)
      .set({ reviewerId, updatedAt: new Date() })
      .where(
        and(eq(performanceReviews.id, id), inArray(performanceReviews.status, [...REASSIGNABLE])),
      )
      .returning();
    return row ?? null;
  }

  async submitSelfAssessment(
    id: string,
    text: string,
    tx?: DbExecutor,
  ): Promise<PerformanceReview | null> {
    const now = new Date();
    const [row] = await this.ex(tx)
      .update(performanceReviews)
      .set({
        selfAssessment: text,
        selfAssessmentSubmittedAt: now,
        status: 'manager_review',
        updatedAt: now,
      })
      .where(and(eq(performanceReviews.id, id), eq(performanceReviews.status, 'self_assessment')))
      .returning();
    return row ?? null;
  }

  async recordRating(
    id: string,
    input: {
      managerSummary: string;
      overallRating: PerformanceRating;
      developmentPlan: string | null;
    },
    tx?: DbExecutor,
  ): Promise<PerformanceReview | null> {
    const now = new Date();
    const [row] = await this.ex(tx)
      .update(performanceReviews)
      .set({
        managerSummary: input.managerSummary,
        overallRating: input.overallRating,
        developmentPlan: input.developmentPlan,
        ratedAt: now,
        updatedAt: now,
      })
      // Stays in `manager_review`: recording a rating is not submitting it, and a reviewer revising
      // a returned review must be able to overwrite what was rejected.
      .where(and(eq(performanceReviews.id, id), eq(performanceReviews.status, 'manager_review')))
      .returning();
    return row ?? null;
  }

  async markPendingApproval(
    id: string,
    requestId: string,
    tx?: DbExecutor,
  ): Promise<PerformanceReview | null> {
    const [row] = await this.ex(tx)
      .update(performanceReviews)
      .set({ status: 'pending_approval', requestId, updatedAt: new Date() })
      .where(and(eq(performanceReviews.id, id), eq(performanceReviews.status, 'manager_review')))
      .returning();
    return row ?? null;
  }

  async markShared(
    id: string,
    approverId: string,
    tx?: DbExecutor,
  ): Promise<PerformanceReview | null> {
    const now = new Date();
    const [row] = await this.ex(tx)
      .update(performanceReviews)
      .set({ status: 'shared', approvedBy: approverId, approvedAt: now, updatedAt: now })
      .where(and(eq(performanceReviews.id, id), eq(performanceReviews.status, 'pending_approval')))
      .returning();
    return row ?? null;
  }

  async returnToReviewer(id: string, tx?: DbExecutor): Promise<PerformanceReview | null> {
    const [row] = await this.ex(tx)
      .update(performanceReviews)
      // The rating STAYS: it is what was rejected, and clearing it would lose what has to change.
      .set({ status: 'manager_review', requestId: null, updatedAt: new Date() })
      .where(and(eq(performanceReviews.id, id), eq(performanceReviews.status, 'pending_approval')))
      .returning();
    return row ?? null;
  }

  async acknowledge(id: string, tx?: DbExecutor): Promise<PerformanceReview | null> {
    const now = new Date();
    const [row] = await this.ex(tx)
      .update(performanceReviews)
      .set({ status: 'acknowledged', acknowledgedAt: now, updatedAt: now })
      .where(and(eq(performanceReviews.id, id), eq(performanceReviews.status, 'shared')))
      .returning();
    return row ?? null;
  }

  async cancelReview(id: string, tx?: DbExecutor): Promise<PerformanceReview | null> {
    const [row] = await this.ex(tx)
      .update(performanceReviews)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(
        and(eq(performanceReviews.id, id), inArray(performanceReviews.status, [...CANCELLABLE])),
      )
      .returning();
    return row ?? null;
  }

  // ── Goals ──────────────────────────────────────────────────────────────────
  async setGoal(input: SetGoalInput, tx?: DbExecutor): Promise<PerformanceGoal> {
    const [row] = await this.ex(tx)
      .insert(performanceGoals)
      .values({
        id: newId(),
        reviewId: input.reviewId,
        title: input.title,
        description: input.description ?? null,
        target: input.target ?? null,
        // numeric(5,2) round-trips as text; a JS number here becomes '3' or '3.00' by value.
        weight: String(input.weight),
      })
      // Re-sending the same goal is an EDIT, not a second row — the weights would be double-counted.
      .onConflictDoUpdate({
        target: [performanceGoals.reviewId, performanceGoals.title],
        set: {
          description: input.description ?? null,
          target: input.target ?? null,
          weight: String(input.weight),
          updatedAt: new Date(),
        },
      })
      .returning();
    return row;
  }

  async listGoals(reviewId: string, tx?: DbExecutor): Promise<PerformanceGoal[]> {
    return (
      this.ex(tx)
        .select()
        .from(performanceGoals)
        .where(eq(performanceGoals.reviewId, reviewId))
        // Heaviest first — the order a reviewer reads them in. `title` is unique per review, so it
        // makes the order total.
        .orderBy(desc(performanceGoals.weight), asc(performanceGoals.title))
    );
  }

  async removeGoal(id: string, tx?: DbExecutor): Promise<PerformanceGoal | null> {
    const [row] = await this.ex(tx)
      .delete(performanceGoals)
      .where(eq(performanceGoals.id, id))
      .returning();
    return row ?? null;
  }

  async rateGoal(
    id: string,
    reviewId: string,
    input: { outcome: string | null; rating: PerformanceRating },
    tx?: DbExecutor,
  ): Promise<PerformanceGoal | null> {
    const [row] = await this.ex(tx)
      .update(performanceGoals)
      .set({ outcome: input.outcome, rating: input.rating, updatedAt: new Date() })
      // `review_id` in the WHERE, not just the id: a goal id from another review would otherwise be
      // rated through this review's permissions.
      .where(and(eq(performanceGoals.id, id), eq(performanceGoals.reviewId, reviewId)))
      .returning();
    return row ?? null;
  }

  // ── Reporting ──────────────────────────────────────────────────────────────
  async coverageGaps(
    cycleId: string,
    limit: number,
    offset: number,
  ): Promise<{ rows: CoverageGap[]; total: number }> {
    /*
     * A LEFT JOIN and not an anti-join alone, because two different gaps matter: an employee with no
     * review at all, and one whose review has stalled short of `acknowledged`. Both are "not done",
     * and a report that showed only the first would call a cycle complete while half its reviews sat
     * unsigned.
     *
     * The employee's position comes from the LIVE assignment here — this is a question about now,
     * not a record of then, which is the opposite of `reviews.position_id`.
     */
    const [rows, [tally]] = await Promise.all([
      this.db
        .select({
          employeeId: employees.id,
          employeeName: employees.displayName,
          email: employees.email,
          positionId: employeePositions.positionId,
          reviewId: performanceReviews.id,
          status: performanceReviews.status,
        })
        .from(employees)
        .leftJoin(
          performanceReviews,
          and(
            eq(performanceReviews.employeeId, employees.id),
            eq(performanceReviews.cycleId, cycleId),
          ),
        )
        .leftJoin(
          employeePositions,
          and(
            eq(employeePositions.employeeId, employees.id),
            isNull(employeePositions.effectiveTo),
          ),
        )
        .where(
          and(
            // Only people who should have one: a leaver is not a gap.
            eq(employees.status, 'active'),
            sql`(${performanceReviews.id} IS NULL OR ${performanceReviews.status} NOT IN ('acknowledged', 'cancelled'))`,
          ),
        )
        // Missing reviews first (NULL status sorts first with NULLS FIRST), then by name. `id` last so
        // the order is total.
        .orderBy(
          sql`${performanceReviews.status} ASC NULLS FIRST`,
          asc(employees.displayName),
          asc(employees.id),
        )
        .limit(limit)
        .offset(offset),
      /*
       * THE TOTAL IS COUNTED OVER THE SAME PREDICATE, in a second query rather than a window function,
       * matching every other paged read here. It is the number that makes the truncation visible: a
       * report that returns fifty rows and says nothing about the other eight hundred is a report that
       * says the cycle is nearly done.
       *
       * `countDistinct` on the employee, not `count()`: an employee with two rows in
       * `employee_positions` — which the live-assignment join does not prevent, only narrows — would
       * otherwise be counted twice and inflate the denominator of a compliance figure.
       */
      this.db
        .select({ total: countDistinct(employees.id) })
        .from(employees)
        .leftJoin(
          performanceReviews,
          and(
            eq(performanceReviews.employeeId, employees.id),
            eq(performanceReviews.cycleId, cycleId),
          ),
        )
        .where(
          and(
            eq(employees.status, 'active'),
            sql`(${performanceReviews.id} IS NULL OR ${performanceReviews.status} NOT IN ('acknowledged', 'cancelled'))`,
          ),
        ),
    ]);
    return { rows, total: Number(tally?.total ?? 0) };
  }

  async cycleProgress(cycleId: string, tx?: DbExecutor): Promise<CycleProgress[]> {
    return (
      this.ex(tx)
        .select({ status: performanceReviews.status, count: count() })
        .from(performanceReviews)
        .where(eq(performanceReviews.cycleId, cycleId))
        .groupBy(performanceReviews.status)
        // `status` is the group key, so it is unique per row and the order is total.
        .orderBy(asc(performanceReviews.status))
    );
  }

  async countUnfinishedReviews(cycleId: string, tx?: DbExecutor): Promise<number> {
    const [row] = await this.ex(tx)
      .select({ total: count() })
      .from(performanceReviews)
      .where(
        and(
          eq(performanceReviews.cycleId, cycleId),
          sql`${performanceReviews.status} NOT IN ('acknowledged', 'cancelled')`,
        ),
      );
    return Number(row?.total ?? 0);
  }
}
