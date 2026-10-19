import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PaginationQuerySchema } from '@shared-kernel';
import {
  performanceCycleStatusEnum,
  performanceRatingEnum,
  performanceReviewStatusEnum,
} from '@db/schema/enums';

const rating = z.enum(performanceRatingEnum.enumValues);
const reviewStatus = z.enum(performanceReviewStatusEnum.enumValues);

// ── Cycles ───────────────────────────────────────────────────────────────────

export const CreateCycleSchema = z.object({
  /** Quoted in HR reporting, so the same uppercase shape as every other reference in OpsHub. */
  reference: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[A-Z][A-Z0-9-]*$/, 'Use uppercase letters, digits and hyphens, e.g. PR-2026-H1'),
  name: z.string().min(2).max(200),
  periodStart: z.string().date(),
  periodEnd: z.string().date(),
  /** Informational: the coverage report reads it, nothing refuses on it. */
  selfAssessmentDue: z.string().date().nullable().optional(),
  reviewDue: z.string().date(),
});
export class CreateCycleDto extends createZodDto(CreateCycleSchema) {}

export const ListCyclesQuerySchema = z
  .object({
    /**
     * Defaults to every status.
     *
     * `all` is spelled out rather than left as an absent value, so a caller reading the query string
     * can see which set they are getting.
     */
    status: z.enum(['all', ...performanceCycleStatusEnum.enumValues]).optional(),
  })
  .merge(PaginationQuerySchema);
export class ListCyclesQueryDto extends createZodDto(ListCyclesQuerySchema) {}

export class CycleResponseDto {
  id!: string;
  reference!: string;
  name!: string;
  periodStart!: string;
  periodEnd!: string;
  selfAssessmentDue!: string | null;
  reviewDue!: string;
  status!: string;
  openedAt!: string | null;
  closedAt!: string | null;
  createdBy!: string;
  createdAt!: string;
}

// ── Reviews ──────────────────────────────────────────────────────────────────

export const CreateReviewSchema = z.object({
  employeeId: z.string().uuid(),
  /**
   * Who writes it. Refused when it equals `employeeId` (412 `PERFORMANCE_SELF_REVIEW`) rather than
   * being caught here: the rule is also `ck_review_reviewer_not_employee`, and a rule stated in
   * three places is one that will eventually disagree with itself.
   */
  reviewerId: z.string().uuid(),
});
export class CreateReviewDto extends createZodDto(CreateReviewSchema) {}

export const ReassignReviewerSchema = z.object({ reviewerId: z.string().uuid() });
export class ReassignReviewerDto extends createZodDto(ReassignReviewerSchema) {}

export const ListReviewsQuerySchema = z
  .object({
    cycleId: z.string().uuid().optional(),
    employeeId: z.string().uuid().optional(),
    reviewerId: z.string().uuid().optional(),
    status: reviewStatus.optional(),
  })
  .merge(PaginationQuerySchema);
export class ListReviewsQueryDto extends createZodDto(ListReviewsQuerySchema) {}

/**
 * Paging alone, for the coverage report.
 *
 * No filters: the report IS the filter — everybody outstanding — and narrowing it by status would let a
 * caller ask "who is outstanding, except the ones I would rather not see". Defined here rather than
 * reusing a shared `PageQueryDto` because every other list in this product declares its own query
 * schema, and one route importing a different pagination type is how two conventions start.
 */
export const CoverageQuerySchema = z.object({}).merge(PaginationQuerySchema);
export class CoverageQueryDto extends createZodDto(CoverageQuerySchema) {}

export const SubmitSelfAssessmentSchema = z.object({
  /** The employee's own account of the period. Substantial by design: a one-word review is not one. */
  selfAssessment: z.string().min(20).max(10_000),
});
export class SubmitSelfAssessmentDto extends createZodDto(SubmitSelfAssessmentSchema) {}

export const SetGoalSchema = z.object({
  /** Unique per review: re-sending the same title EDITS that goal rather than adding a second. */
  title: z.string().min(2).max(200),
  description: z.string().max(5000).nullable().optional(),
  target: z.string().max(2000).nullable().optional(),
  /**
   * Percentage share of the overall judgement.
   *
   * The individual bound is here because it is a fact about one value; the requirement that a
   * review's goals TOTAL 100 is enforced when the review is submitted, because it is a fact about a
   * set and a partial set is a legal step towards a complete one.
   */
  weight: z.number().positive().max(100),
});
export class SetGoalDto extends createZodDto(SetGoalSchema) {}

export const RateReviewSchema = z.object({
  managerSummary: z.string().min(20).max(10_000),
  overallRating: rating,
  /**
   * Required when the rating's scale entry says so (412 `PERFORMANCE_DEVELOPMENT_PLAN_REQUIRED`).
   *
   * Not conditional here, because which ratings require one lives in
   * `performance.rating_scale.requires_development_plan` — a table the DTO cannot read, and the only
   * place that decision should be changed.
   */
  developmentPlan: z.string().max(10_000).nullable().optional(),
  /** Per-goal outcomes and grades. A goal not named keeps whatever it had. */
  goals: z
    .array(
      z.object({
        id: z.string().uuid(),
        outcome: z.string().max(5000).nullable().optional(),
        rating,
      }),
    )
    .max(50)
    .optional(),
});
export class RateReviewDto extends createZodDto(RateReviewSchema) {}

export const CancelReviewSchema = z.object({
  /** Recorded in the audit entry: a withdrawn review with no stated reason is unexplainable later. */
  reason: z.string().min(5).max(1000),
});
export class PerformanceCancelReviewDto extends createZodDto(CancelReviewSchema) {}

export class ReviewResponseDto {
  id!: string;
  cycleId!: string;
  employeeId!: string;
  /** Resolved server-side. Null when the employee row is gone; the review still stands. */
  employeeName!: string | null;
  reviewerId!: string;
  /** Resolved server-side. Null when the reviewer has left — which is why reassignment exists. */
  reviewerName!: string | null;
  /** The role the employee was reviewed IN, frozen at creation. Null when unassigned then. */
  positionId!: string | null;
  status!: string;
  selfAssessment!: string | null;
  selfAssessmentSubmittedAt!: string | null;
  managerSummary!: string | null;
  overallRating!: string | null;
  developmentPlan!: string | null;
  ratedAt!: string | null;
  /** The engine request carrying the calibration sign-off. Null until submitted. */
  requestId!: string | null;
  approvedBy!: string | null;
  approvedAt!: string | null;
  acknowledgedAt!: string | null;
  createdAt!: string;
}

export class GoalResponseDto {
  id!: string;
  reviewId!: string;
  title!: string;
  description!: string | null;
  target!: string | null;
  /** `numeric(5,2)` in the column; a number in the contract. */
  weight!: number;
  outcome!: string | null;
  rating!: string | null;
}

export class RatingLevelResponseDto {
  code!: string;
  /** Higher is better. THE ordering — do not sort on `code`. */
  rank!: number;
  label!: string;
  description!: string;
  /** Whether sharing a review at this rating requires a development plan. */
  requiresDevelopmentPlan!: boolean;
}

export class CoverageGapResponseDto {
  employeeId!: string;
  employeeName!: string;
  email!: string;
  /** The employee's CURRENT position — this is a question about now, not a record of then. */
  positionId!: string | null;
  /** Null when no review exists at all, which is the case the report exists for. */
  reviewId!: string | null;
  status!: string | null;
}

export class CycleProgressResponseDto {
  status!: string;
  count!: number;
}
