-- ============================================================================
-- Migration 0026: management review (ISO 9001 §9.3)
-- ============================================================================
-- WHY THIS MODULE IS MOSTLY A JOIN
--
-- §9.3.2 lists what a review must CONSIDER, and every item is something another
-- register already answers:
--
--   (c)(4) nonconformities and corrective actions -> the recurrence and
--          containment-overdue reports (migration 0024)
--   (c)(6) audit results                          -> the audit programme and its
--          unlinked findings (0025)
--   (c)(7) performance of external providers      -> vendor review gaps and
--          unassessed spend (0023)
--   (e)    effectiveness of actions on risks      -> the untreated-risk report (0020)
--   (a)    status of actions from previous reviews -> this migration's own action rows
--
-- So this module COMPOSES those rather than storing copies. A second copy of "how
-- many findings are overdue" would disagree with the register within a day.
--
-- WHAT IT DOES STORE IS THE SNAPSHOT
--
-- `management_reviews.inputs` is those composed reports FROZEN at the moment the
-- review was held. That is the one thing the join cannot give you: minutes have to
-- show what the numbers WERE on the day. A live re-read would silently turn "eleven
-- findings overdue" into "three" once the backlog cleared, and the decision recorded
-- beside it would stop making sense.
--
-- `jsonb` rather than columns, deliberately. The shape is a REPORT BUNDLE whose
-- members change whenever a register adds a report — three of them arrived in the
-- last three migrations — and a column per metric would mean a migration every time,
-- with every historical row backfilled to a value nobody measured. The snapshot is
-- write-once, read-as-a-whole, and never queried by member, which is exactly the
-- shape `jsonb` is for. Nothing in the application filters on its contents.
--
-- NO ATTENDANCE REGISTER, DELIBERATELY. §9.3 requires top management to review,
-- evidenced by `chair_id` and the minutes document. A full attendee roster is good
-- practice rather than a clause requirement, and `internal_audit_auditors` already
-- carries the one roster that IS load-bearing — its impartiality rule reads it. A
-- second link table nothing enforces against would be shape without a rule.
--
-- INVARIANTS
--
-- 1. HOLDING A REVIEW FREEZES ITS INPUTS — `ck_mr_held_pair`. A review recorded as
--    held with no snapshot is a meeting nobody can reconstruct, and §9.3.2 is a list
--    of things that must have been considered.
--
-- 2. CLOSING NEEDS THE MINUTES AND A CONCLUSION — `ck_mr_closed_pair`. §9.3.3 asks
--    for documented outputs; a review with none produced nothing.
--
-- 3. A CANCELLED REVIEW WAS NEVER HELD, and says why — `ck_mr_cancelled_pair`,
--    `ck_mr_cancelled_clean`.
--
-- 4. AN ACTION'S TERMINAL STATE CARRIES ITS OUTCOME — `ck_mr_action_completed_pair`,
--    `ck_mr_action_outcome_note`.
--
-- Every implication CHECK uses `coalesce(x, '')`: a CHECK that evaluates to NULL is
-- SATISFIED, so the naive spelling accepts precisely the row where the column was
-- omitted. Migration 0023 shipped that bug three times.
--
-- WHAT THE SERVICE HOLDS THAT NO CHECK CAN
--
--   * THE SNAPSHOT IS COMPOSED, NEVER SUPPLIED. No API accepts `inputs`, for the same
--     reason none accepts a risk score or a vendor's next review date.
--   * REVIEWS ARE HELD IN ORDER. §9.3.2(a) — the status of actions from PREVIOUS
--     reviews — only means something if "previous" is settled, so a review cannot be
--     held while an earlier scheduled one is still outstanding.
--   * A CLOSED REVIEW ACCEPTS NO NEW ACTIONS. An action added afterwards is an output
--     the minutes do not contain.
-- ============================================================================

CREATE TYPE management_review_status AS ENUM ('scheduled', 'held', 'closed', 'cancelled');

-- The three outputs §9.3.3 names, and nothing else. The clause is a closed list, so
-- this enum IS the clause — an `other` value would let every action be filed as
-- unclassifiable, which is what the list exists to prevent.
CREATE TYPE management_review_action_category AS ENUM (
  'improvement',
  'qms_change',
  'resource_need'
);

CREATE TYPE management_review_action_status AS ENUM (
  'open',
  'in_progress',
  'completed',
  'cancelled'
);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS qms.management_reviews (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Quoted in the minutes and in every action it raises, e.g. `MR-2026-H1`.
  reference           varchar(40) NOT NULL,
  title               varchar(200) NOT NULL,
  -- The period under review, as free text: §9.3.1 says "at planned intervals" and
  -- leaves the interval to the organisation, so a date range would invite arithmetic
  -- the clause does not ask for.
  period              varchar(120) NOT NULL,

  status              management_review_status NOT NULL DEFAULT 'scheduled',

  -- No FK: `identity.employees` is a separate schema and every other cross-schema
  -- reference in this codebase is by id alone, so the service checks it.
  chair_id            uuid NOT NULL,

  scheduled_for       date,
  held_on             date,

  -- The §9.3.2 inputs, frozen when the review was held. See the header for why jsonb.
  inputs              jsonb,

  conclusion          text,
  minutes_document_id uuid,

  closed_at           timestamptz,
  cancel_reason       text,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  -- Invariant 1. An equivalence, so the snapshot cannot be populated on a review that
  -- has not been held either. `'{}'::jsonb` is rejected as emphatically as NULL: an
  -- empty bundle is the shape a failed composition would leave behind.
  CONSTRAINT ck_mr_held_pair CHECK (
    (status IN ('held', 'closed'))
    = (held_on IS NOT NULL AND inputs IS NOT NULL AND inputs <> '{}'::jsonb)
  ),
  -- Invariant 2.
  CONSTRAINT ck_mr_closed_pair CHECK (
    (status = 'closed')
    = (closed_at IS NOT NULL
       AND minutes_document_id IS NOT NULL
       AND length(btrim(coalesce(conclusion, ''))) >= 10)
  ),
  -- Invariant 3.
  CONSTRAINT ck_mr_cancelled_pair CHECK (
    (status = 'cancelled') = (length(btrim(coalesce(cancel_reason, ''))) >= 10)
  ),
  CONSTRAINT ck_mr_cancelled_clean CHECK (
    status <> 'cancelled' OR (held_on IS NULL AND closed_at IS NULL)
  ),
  CONSTRAINT ck_mr_title_substance CHECK (length(btrim(title)) >= 5),
  CONSTRAINT ck_mr_period_substance CHECK (length(btrim(period)) >= 2)
);

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS uq_management_review_reference
  ON qms.management_reviews (reference);
CREATE INDEX IF NOT EXISTS ix_management_review_status ON qms.management_reviews (status);
-- The programme view, and the ordering rule: reviews are held in scheduled order.
CREATE INDEX IF NOT EXISTS ix_management_review_scheduled
  ON qms.management_reviews (scheduled_for);
CREATE INDEX IF NOT EXISTS ix_management_review_chair ON qms.management_reviews (chair_id);

--> statement-breakpoint

-- §9.3.3 outputs. These rows are also what §9.3.2(a) reads: the next review's frozen
-- inputs include every action of an earlier review still open, so the clause is
-- satisfied by construction rather than by somebody remembering to look.
CREATE TABLE IF NOT EXISTS qms.management_review_actions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  management_review_id uuid NOT NULL
                         REFERENCES qms.management_reviews (id) ON DELETE CASCADE,

  category             management_review_action_category NOT NULL,
  description          text NOT NULL,

  owner_id             uuid NOT NULL,
  due_on               date,

  status               management_review_action_status NOT NULL DEFAULT 'open',
  completed_at         timestamptz,
  outcome_note         text,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  -- Invariant 4.
  CONSTRAINT ck_mr_action_completed_pair CHECK (
    (status = 'completed') = (completed_at IS NOT NULL)
  ),
  CONSTRAINT ck_mr_action_outcome_note CHECK (
    status NOT IN ('completed', 'cancelled')
    OR length(btrim(coalesce(outcome_note, ''))) >= 10
  ),
  -- An action whose description says "improve things" is not an action.
  CONSTRAINT ck_mr_action_description_substance CHECK (length(btrim(description)) >= 10)
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS ix_mr_action_review
  ON qms.management_review_actions (management_review_id, status);
CREATE INDEX IF NOT EXISTS ix_mr_action_owner ON qms.management_review_actions (owner_id);
-- The overdue report, and the carried-forward input for the next review.
CREATE INDEX IF NOT EXISTS ix_mr_action_due
  ON qms.management_review_actions (status, due_on);

--> statement-breakpoint

-- ============================================================================
-- Grants
-- ============================================================================
-- `qms` carries `ALTER DEFAULT PRIVILEGES` from migration 0024, so both tables arrive
-- usable. Granted explicitly anyway, as 0025 does: if that default were ever reverted
-- these tables would still work rather than failing on the first insert in CI.
--
-- Nothing here is reference data, so there is no REVOKE. The snapshot is write-once by
-- convention and by the service's own API — there is no route that edits it — but the
-- row it lives on is edited throughout the review's life, so a privilege-level
-- restriction would have to sit on a column and Postgres grants UPDATE per column
-- only in a form that a future column addition silently escapes.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON qms.management_reviews, qms.management_review_actions
      TO opshub_app, opshub_worker;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_migrate') THEN
      GRANT ALL ON qms.management_reviews, qms.management_review_actions TO opshub_migrate;
    END IF;
  END IF;
END $$;
