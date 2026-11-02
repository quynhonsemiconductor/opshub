/**
 * performance schema — review cycles, the review per employee, and the goals it judges.
 *
 * WHY A CYCLE AND NOT A YEAR ON THE REVIEW
 * ----------------------------------------
 * "Who has not been reviewed yet" is the question this exists to answer, and a year column cannot
 * answer it: an absent row means both "not due" and "overdue", and nothing says when the window
 * closed. The cycle owns the period and the deadlines, so coverage is an anti-join against the
 * employees with no review in it — the same shape as the competency gap report.
 *
 * THE POSITION IS FROZEN, THE ASSIGNMENT IS NOT. `reviews.position_id` is copied from the current
 * assignment at creation and never updated: a review is a judgement about how somebody did IN A
 * ROLE, so a transfer in March must not restate what December's review was about. That is the
 * opposite choice from the competency gap report, which reads the LIVE assignment — a gap is a fact
 * about now, a review is a record of then.
 *
 * THE RATING SCALE IS A REFERENCE TABLE WITH A RANK, the fifth instance of the pattern
 * (`isms.classification_levels`, `isms.vendor_criticality_levels`, `qms.nonconformance_severities`,
 * `workforce.leave_policies`). `rank` is the authoritative ordering, NOT enum declaration order,
 * and `requires_development_plan` is the gate — the same shape as `requires_capa` on a
 * non-conformance grade.
 *
 * THE SIGN-OFF IS THE REQUEST ENGINE'S, not a second approver column with its own checks. A
 * calibration decision is an approval, so it gets the spine every other approval in OpsHub uses:
 * separation of duties, SLA, expiry, audit and notifications. `request_id` is the backlink.
 */
import {
  boolean,
  date,
  index,
  numeric,
  pgSchema,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import {
  performanceCycleStatusEnum,
  performanceRatingEnum,
  performanceReviewStatusEnum,
} from './enums';
import { positions } from './positions';
import { requestItems } from './requests';

export const performanceSchema = pgSchema('performance');

export const performanceRatingScale = performanceSchema.table('rating_scale', {
  code: performanceRatingEnum('code').primaryKey(),
  /** Higher is better. THE authoritative ordering — see the enum's own comment. */
  rank: smallint('rank').notNull(),
  label: varchar('label', { length: 60 }).notNull(),
  description: text('description').notNull(),
  /**
   * Whether sharing a review at this rating requires a development plan.
   *
   * Read by the gate in `PerformanceService`. "Meets" does not; "needs improvement" does, and that
   * is the difference between a rating and a decision about what happens next.
   */
  requiresDevelopmentPlan: boolean('requires_development_plan').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const performanceCycles = performanceSchema.table(
  'cycles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Quoted in HR reporting and management review minutes, e.g. `PR-2026-H1`. */
    reference: varchar('reference', { length: 40 }).notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    /** The period being reviewed — NOT the window for doing the reviewing. */
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),
    /** Informational: the coverage report reads it, nothing refuses on it. */
    selfAssessmentDue: date('self_assessment_due'),
    reviewDue: date('review_due').notNull(),
    status: performanceCycleStatusEnum('status').notNull().default('draft'),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    referenceIdx: uniqueIndex('ux_cycle_reference').on(t.reference),
  }),
);

export const performanceReviews = performanceSchema.table(
  'reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cycleId: uuid('cycle_id')
      .notNull()
      .references(() => performanceCycles.id, { onDelete: 'restrict' }),
    employeeId: uuid('employee_id').notNull(),
    /** Who writes the review. NOT NULL — an unassigned review is a reminder, not a review. */
    reviewerId: uuid('reviewer_id').notNull(),
    /**
     * The role the employee was reviewed IN, frozen at creation.
     *
     * Nullable because somebody can be between assignments, and refusing to review them for that
     * reason would be the tail wagging the dog.
     */
    positionId: uuid('role_id').references(() => positions.id, { onDelete: 'set null' }),
    status: performanceReviewStatusEnum('status').notNull().default('self_assessment'),

    selfAssessment: text('self_assessment'),
    selfAssessmentSubmittedAt: timestamp('self_assessment_submitted_at', { withTimezone: true }),

    managerSummary: text('manager_summary'),
    overallRating: performanceRatingEnum('overall_rating').references(
      () => performanceRatingScale.code,
      { onDelete: 'restrict' },
    ),
    developmentPlan: text('development_plan'),
    ratedAt: timestamp('rated_at', { withTimezone: true }),

    /** The calibration sign-off, through the request engine like every other approval. */
    requestId: uuid('request_id').references(() => requestItems.id, { onDelete: 'set null' }),
    approvedBy: uuid('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),

    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),

    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    cycleEmployeeIdx: uniqueIndex('ux_review_cycle_employee').on(t.cycleId, t.employeeId),
    employeeIdx: index('ix_review_employee').on(t.employeeId, t.cycleId),
    reviewerIdx: index('ix_review_reviewer').on(t.reviewerId, t.status),
    cycleStatusIdx: index('ix_review_cycle_status').on(t.cycleId, t.status),
  }),
);

export const performanceGoals = performanceSchema.table(
  'goals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** CASCADE: a goal has no meaning apart from the review it was set for. */
    reviewId: uuid('review_id')
      .notNull()
      .references(() => performanceReviews.id, { onDelete: 'cascade' }),
    title: varchar('title', { length: 200 }).notNull(),
    description: text('description'),
    /** What "done" looks like, agreed up front. The thing that makes a rating arguable. */
    target: text('target'),
    /**
     * Percentage share of the overall judgement.
     *
     * The service requires a review's goals to total 100 before it can be sent for approval — a sum
     * across rows, so no CHECK can see it.
     */
    weight: numeric('weight', { precision: 5, scale: 2 }).notNull(),
    outcome: text('outcome'),
    rating: performanceRatingEnum('rating').references(() => performanceRatingScale.code, {
      onDelete: 'restrict',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    reviewTitleIdx: uniqueIndex('ux_goal_review_title').on(t.reviewId, t.title),
    reviewIdx: index('ix_goal_review').on(t.reviewId),
  }),
);
