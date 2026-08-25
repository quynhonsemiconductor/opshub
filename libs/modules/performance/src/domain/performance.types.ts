import type {
  performanceCycleStatusEnum,
  performanceRatingEnum,
  performanceReviewStatusEnum,
} from '../../../../../db/schema';

export type PerformanceCycleStatus = (typeof performanceCycleStatusEnum.enumValues)[number];
export type PerformanceReviewStatus = (typeof performanceReviewStatusEnum.enumValues)[number];
/** A rating NAME. The ordering lives in `performance.rating_scale.rank` — see the enum's comment. */
export type PerformanceRating = (typeof performanceRatingEnum.enumValues)[number];

/** One grade of the scale, with the gate that makes a low rating actionable. */
export interface PerformanceRatingLevel {
  code: PerformanceRating;
  rank: number;
  label: string;
  description: string;
  requiresDevelopmentPlan: boolean;
}

export interface PerformanceCycle {
  id: string;
  reference: string;
  name: string;
  periodStart: string;
  periodEnd: string;
  selfAssessmentDue: string | null;
  reviewDue: string;
  status: PerformanceCycleStatus;
  openedAt: Date | null;
  closedAt: Date | null;
  createdBy: string;
  createdAt: Date;
}

export interface PerformanceReview {
  id: string;
  cycleId: string;
  employeeId: string;
  reviewerId: string;
  /** The role the employee was reviewed IN, frozen at creation. */
  positionId: string | null;
  status: PerformanceReviewStatus;
  selfAssessment: string | null;
  selfAssessmentSubmittedAt: Date | null;
  managerSummary: string | null;
  overallRating: PerformanceRating | null;
  developmentPlan: string | null;
  ratedAt: Date | null;
  requestId: string | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  acknowledgedAt: Date | null;
  createdBy: string;
  createdAt: Date;
}

export interface PerformanceGoal {
  id: string;
  reviewId: string;
  title: string;
  description: string | null;
  target: string | null;
  /** `numeric(5,2)`, so the driver hands it back as a STRING. The DTO converts. */
  weight: string;
  outcome: string | null;
  rating: PerformanceRating | null;
}

export interface CreateCycleInput {
  reference: string;
  name: string;
  periodStart: string;
  periodEnd: string;
  selfAssessmentDue?: string | null;
  reviewDue: string;
  createdBy: string;
}

export interface CreateReviewInput {
  cycleId: string;
  employeeId: string;
  reviewerId: string;
  positionId: string | null;
  createdBy: string;
  /**
   * The state the review OPENS IN, which depends on the cycle rather than on the column default.
   *
   * A review used to be born `self_assessment` unconditionally. The only transition out of that state
   * is the subject submitting their own account — so a cycle with no self-assessment step, which the
   * product explicitly offers ("leave the date empty"), produced reviews that nobody could ever rate:
   * the reviewer saw no Rate action because rating requires `manager_review`, and the subject was
   * required to write something the cycle had said was not required.
   */
  status: PerformanceReview['status'];
}

export interface SetGoalInput {
  reviewId: string;
  title: string;
  description?: string | null;
  target?: string | null;
  weight: number;
}

export interface RateReviewInput {
  managerSummary: string;
  overallRating: PerformanceRating;
  developmentPlan?: string | null;
  /** Per-goal outcomes and grades, keyed by goal id. A goal not named here keeps what it had. */
  goals?: { id: string; outcome?: string | null; rating: PerformanceRating }[];
}

export interface ReviewFilters {
  cycleId?: string;
  employeeId?: string;
  reviewerId?: string;
  status?: PerformanceReviewStatus;
}

/** An employee in an open cycle with no review, or one that has stalled in a state. */
export interface CoverageGap {
  employeeId: string;
  employeeName: string;
  email: string;
  positionId: string | null;
  /** Null when no review exists at all — the case the report exists for. */
  reviewId: string | null;
  status: PerformanceReviewStatus | null;
}

/** How many reviews sit in each state of a cycle. */
export interface CycleProgress {
  status: PerformanceReviewStatus;
  count: number;
}
