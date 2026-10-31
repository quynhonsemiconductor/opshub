-- ============================================================================
-- Migration 0029: performance reviews
-- ============================================================================
-- The last gap in EMS. A review is a CYCLE (the period everyone is reviewed for),
-- a REVIEW per employee within it, and the GOALS that review is judged against.
--
-- WHY A CYCLE TABLE AND NOT A YEAR COLUMN
--
-- "Who has not been reviewed yet" is the question this feature exists to answer,
-- and it is unanswerable from a year on a review row: an absent row means both
-- "not due" and "overdue", and nothing says when the window closed. The cycle
-- owns the period and the deadlines, so coverage is an anti-join against the
-- employees who have no review in it — the same shape as the competency gap
-- report, and correct for the same reason.
--
-- THE POSITION IS FROZEN, THE ASSIGNMENT IS NOT
--
-- `reviews.position_id` is copied from the employee's CURRENT assignment when the
-- review is created and never updated. A review is a judgement about how somebody
-- did IN A ROLE, so a transfer in March must not restate what December's review
-- was about. This is the opposite choice from the competency gap report, which
-- deliberately reads the live assignment — the difference is that a gap is a fact
-- about now and a review is a record of then.
--
-- RATINGS ARE A REFERENCE TABLE WITH A RANK
--
-- `rating_scale`, the fifth instance of the pattern (`classification_levels`,
-- `vendor_criticality_levels`, `nonconformance_severities`, `leave_policies`).
-- `rank` is the authoritative ordering and is NOT enum declaration order: the enum
-- is a set of names, and a distribution report that sorted by it would be sorting
-- by an accident of how the type was written.
--
-- `requires_development_plan` is the gate, exactly as `requires_capa` is for a
-- non-conformance grade. A poor rating with no plan attached is a complaint about
-- somebody rather than a decision about what happens next.
--
-- INVARIANTS
--
-- 1. NOBODY REVIEWS THEMSELVES — `ck_review_reviewer_not_employee`. The whole
--    point of the record is a second opinion; a self-review is the self-assessment
--    field, which already exists on the row.
--
-- 2. ONE REVIEW PER EMPLOYEE PER CYCLE — `ux_review_cycle_employee`. Two rows
--    would make "reviewed?" ambiguous and the coverage report double-count.
--
-- 3. A SHARED REVIEW HAS A RATING — `ck_review_rating_before_sharing`. A review an
--    employee can see with no rating on it is a form, not a review.
--
-- 4. ACKNOWLEDGEMENT AND ITS TIMESTAMP AGREE — `ck_review_acknowledged_pair`, and
--    the same for the self-assessment (`ck_review_self_assessment_pair`) and the
--    approval (`ck_review_approval_pair`). A status that says acknowledged with no
--    date is unusable as evidence, and a date with another status is a lie about
--    the row.
--
-- 5. A GOAL'S WEIGHT IS A REAL SHARE — `ck_goal_weight_range`, 0 exclusive to 100
--    inclusive. A zero-weight goal is one nobody is judged on.
--
-- 6. THE CYCLE'S DATES MAKE SENSE — `ck_cycle_window`, `ck_cycle_review_after_period`,
--    `ck_cycle_self_before_review`. You cannot review a period before it has ended,
--    and a self-assessment due after the review is due helps nobody.
--
-- THE NULL TRAP
--
-- A CHECK that evaluates to NULL is SATISFIED (see migration 0023), so every
-- implication below over a nullable column is written to be TOTAL: paired
-- constraints compare two `IS NOT NULL` expressions, which are never NULL, and the
-- rating gate names the statuses explicitly rather than testing the rating alone.
--
-- WHAT THE SERVICE HOLDS THAT NO CHECK CAN
--
--   * GOAL WEIGHTS TOTALLING 100. A sum across rows, so no row-level CHECK can see
--     it; enforced when the review is sent for approval, which is the moment the
--     weights stop being a draft.
--   * THE DEVELOPMENT-PLAN GATE. `requires_development_plan` lives on the scale
--     and the plan on the review — two tables, so a CHECK cannot compare them.
--   * THE STATE MACHINE. Guarded `WHERE status = <from>` on every transition, so
--     two concurrent callers cannot both move the same review.
--   * WHO MAY APPROVE. The engine keeps the reviewer from signing off their own
--     submission; the type def additionally refuses the EMPLOYEE, who would
--     otherwise be able to approve their own review with `performance.approve`.
--   * CLOSING A CYCLE WITH UNFINISHED REVIEWS. A count across rows.
-- ============================================================================

CREATE TYPE performance_cycle_status AS ENUM ('draft', 'open', 'closed');

--> statement-breakpoint

CREATE TYPE performance_review_status AS ENUM (
  'self_assessment',
  'manager_review',
  'pending_approval',
  'shared',
  'acknowledged',
  'cancelled'
);

--> statement-breakpoint

-- Names only. The ORDER lives in `rating_scale.rank`.
CREATE TYPE performance_rating AS ENUM (
  'unsatisfactory',
  'needs_improvement',
  'meets',
  'exceeds',
  'outstanding'
);

--> statement-breakpoint

CREATE SCHEMA IF NOT EXISTS performance;

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS performance.rating_scale (
  code                     performance_rating PRIMARY KEY,
  -- Higher is better. THE authoritative ordering — see the enum's comment.
  rank                     smallint NOT NULL,
  label                    varchar(60) NOT NULL,
  description              text NOT NULL,
  -- Whether sharing a review at this rating requires a development plan.
  requires_development_plan boolean NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ux_rating_scale_rank UNIQUE (rank),
  CONSTRAINT ck_rating_scale_rank_positive CHECK (rank > 0)
);

--> statement-breakpoint

INSERT INTO performance.rating_scale (code, rank, label, description, requires_development_plan)
VALUES
  ('unsatisfactory', 1, 'Unsatisfactory',
   'Did not meet the requirements of the role. A development plan is mandatory: a rating this low '
   || 'with nothing attached to it is a complaint about somebody rather than a decision about what '
   || 'happens next.', true),
  ('needs_improvement', 2, 'Needs improvement',
   'Met some expectations and fell short of others. A development plan is mandatory, for the same '
   || 'reason — the gap is the point of recording it.', true),
  ('meets', 3, 'Meets expectations',
   'Did the job the role asks for. The expected outcome, and deliberately the middle of a '
   || 'five-point scale so that "meets" is not the lowest thing anybody wants written down.', false),
  ('exceeds', 4, 'Exceeds expectations',
   'Consistently delivered beyond the role''s requirements.', false),
  ('outstanding', 5, 'Outstanding',
   'Exceptional against the role and a visible contribution beyond it.', false)
ON CONFLICT (code) DO NOTHING;

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS performance.cycles (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Quoted in minutes and HR reporting, e.g. `PR-2026-H1`.
  reference           varchar(40) NOT NULL,
  name                varchar(200) NOT NULL,
  -- The period being reviewed, not the window for doing the reviewing.
  period_start        date NOT NULL,
  period_end          date NOT NULL,
  self_assessment_due date,
  review_due          date NOT NULL,
  status              performance_cycle_status NOT NULL DEFAULT 'draft',
  opened_at           timestamptz,
  closed_at           timestamptz,
  created_by          uuid NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ux_cycle_reference UNIQUE (reference),
  -- Invariant 6.
  CONSTRAINT ck_cycle_window CHECK (period_end >= period_start),
  CONSTRAINT ck_cycle_review_after_period CHECK (review_due >= period_end),
  CONSTRAINT ck_cycle_self_before_review CHECK (
    self_assessment_due IS NULL OR self_assessment_due <= review_due
  ),
  -- Total, not an implication over a nullable column: both sides are `IS NOT NULL`.
  CONSTRAINT ck_cycle_opened_pair CHECK ((status <> 'draft') = (opened_at IS NOT NULL)),
  CONSTRAINT ck_cycle_closed_pair CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS performance.reviews (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id                    uuid NOT NULL REFERENCES performance.cycles(id) ON DELETE RESTRICT,
  employee_id                 uuid NOT NULL,
  -- Who writes the review. NOT NULL: an unassigned review is a reminder, not a review.
  reviewer_id                 uuid NOT NULL,
  /*
   * The role the employee was reviewed IN, frozen at creation.
   *
   * Nullable because an employee can be between assignments, and refusing to review them for that
   * reason would be the tail wagging the dog. NOT recomputed on read: see the header.
   */
  position_id                 uuid REFERENCES positions.positions(id) ON DELETE SET NULL,
  status                      performance_review_status NOT NULL DEFAULT 'self_assessment',

  self_assessment             text,
  self_assessment_submitted_at timestamptz,

  manager_summary             text,
  overall_rating              performance_rating REFERENCES performance.rating_scale(code)
                                ON DELETE RESTRICT,
  development_plan            text,
  rated_at                    timestamptz,

  -- The calibration sign-off, through the request engine like every other approval.
  request_id                  uuid REFERENCES requests.request_items(id) ON DELETE SET NULL,
  approved_by                 uuid,
  approved_at                 timestamptz,

  acknowledged_at             timestamptz,

  created_by                  uuid NOT NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  -- Invariant 1.
  CONSTRAINT ck_review_reviewer_not_employee CHECK (reviewer_id <> employee_id),
  -- Invariant 3. Names the states rather than testing the rating, so it cannot pass on a NULL.
  CONSTRAINT ck_review_rating_before_sharing CHECK (
    status IN ('self_assessment', 'manager_review', 'cancelled') OR overall_rating IS NOT NULL
  ),
  -- Invariant 4, three total equalities.
  CONSTRAINT ck_review_self_assessment_pair CHECK (
    (self_assessment IS NOT NULL) = (self_assessment_submitted_at IS NOT NULL)
  ),
  CONSTRAINT ck_review_approval_pair CHECK (
    (approved_by IS NOT NULL) = (approved_at IS NOT NULL)
  ),
  CONSTRAINT ck_review_acknowledged_pair CHECK (
    (status = 'acknowledged') = (acknowledged_at IS NOT NULL)
  ),
  -- Invariant 2.
  CONSTRAINT ux_review_cycle_employee UNIQUE (cycle_id, employee_id)
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS ix_review_employee ON performance.reviews (employee_id, cycle_id);
CREATE INDEX IF NOT EXISTS ix_review_reviewer ON performance.reviews (reviewer_id, status);
CREATE INDEX IF NOT EXISTS ix_review_cycle_status ON performance.reviews (cycle_id, status);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS performance.goals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- CASCADE: a goal has no meaning apart from the review it was set for.
  review_id   uuid NOT NULL REFERENCES performance.reviews(id) ON DELETE CASCADE,
  title       varchar(200) NOT NULL,
  description text,
  -- What "done" looks like, agreed up front. The thing that makes a rating arguable.
  target      text,
  -- Percentage share of the overall judgement. The service requires the set to total 100.
  weight      numeric(5, 2) NOT NULL,
  outcome     text,
  rating      performance_rating REFERENCES performance.rating_scale(code) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  -- Invariant 5.
  CONSTRAINT ck_goal_weight_range CHECK (weight > 0 AND weight <= 100),
  -- One row per goal title per review: two "Improve test coverage" rows are a mistake, and the
  -- weights would be counted twice.
  CONSTRAINT ux_goal_review_title UNIQUE (review_id, title)
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS ix_goal_review ON performance.goals (review_id);

--> statement-breakpoint

-- ============================================================================
-- Grants
-- ============================================================================
-- `performance` is a NEW schema, so migration 0012's blanket grants and default
-- privileges do not reach it — every schema created since has had to grant
-- explicitly, and `db/enable-least-privilege-roles.ts` now derives its schema list
-- so it fails the build if this is forgotten.
--
-- `rating_scale` is REFERENCE DATA, seeded above and changed by migration only: a
-- rating scale is a policy decision, reviewed, not typed in by whoever holds
-- `performance.manage`. Granted then REVOKEd rather than granted narrowly, because
-- the default privileges re-attach writes at CREATE TABLE and a smaller GRANT here
-- would read like a restriction and change nothing (see migration 0022).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_app') THEN
    GRANT USAGE ON SCHEMA performance TO opshub_app, opshub_worker;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_migrate') THEN
      GRANT USAGE ON SCHEMA performance TO opshub_migrate;
    END IF;

    GRANT SELECT, INSERT, UPDATE, DELETE
      ON ALL TABLES IN SCHEMA performance TO opshub_app, opshub_worker;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA performance TO opshub_app, opshub_worker;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_migrate') THEN
      GRANT ALL ON SCHEMA performance TO opshub_migrate;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_migrate') THEN
      GRANT ALL ON ALL TABLES IN SCHEMA performance TO opshub_migrate;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_migrate') THEN
      GRANT ALL ON ALL SEQUENCES IN SCHEMA performance TO opshub_migrate;
    END IF;

    ALTER DEFAULT PRIVILEGES IN SCHEMA performance
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO opshub_app, opshub_worker;
    ALTER DEFAULT PRIVILEGES IN SCHEMA performance
      GRANT USAGE, SELECT ON SEQUENCES TO opshub_app, opshub_worker;

    REVOKE INSERT, UPDATE, DELETE ON performance.rating_scale FROM opshub_app, opshub_worker;
  END IF;
END $$;
