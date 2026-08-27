-- ============================================================================
-- Migration 0033: a notified breach cannot stop being a breach
-- ============================================================================
-- INVARIANT 5 on `isms.incidents`, alongside the four migration 0021 wrote down:
-- a recorded regulator notification IMPLIES the incident is a personal-data
-- breach. `personal_data_breach = false` next to a `regulator_notified_at` is a
-- row asserting both that no personal data was involved and that a supervisory
-- authority was told about the personal data involved.
--
-- WHAT WENT WRONG WITHOUT IT. `PATCH /v1/incidents/{id}` accepted
-- `{"personalDataBreach": false}` at any time, including after
-- `POST /v1/incidents/{id}/regulator-notified` had stamped the timestamp. The
-- result was not merely wrong, it was UNRECOVERABLE in both directions:
--
--   * `markRegulatorNotified` updates `WHERE personal_data_breach = true AND
--     regulator_notified_at IS NULL`, so it can neither re-stamp nor correct the
--     row, and there is no un-notify route — `regulator-notified` is the only one.
--   * the overdue-breach report and `ix_incident_breach_detected` both filter on
--     exactly that pair, so the incident vanishes from the register a DPO reads
--     while still carrying proof a regulator was notified.
--
-- The service now refuses it with `INCIDENT_BREACH_NOTIFIED`. This constraint is
-- the same rule for everything that does NOT come through the service: the seed,
-- a migration, a psql session, a future endpoint that sets the columns directly.
-- That division is the one migration 0021 already describes — the CHECKs describe
-- a valid ROW, the service describes a valid MOVE.
--
-- AN IMPLICATION, NOT AN EQUIVALENCE, for the same reason as
-- `ck_incident_contained_pair`. `personal_data_breach = (regulator_notified_at IS
-- NOT NULL)` would forbid a breach that has not been notified YET — which is the
-- normal state for the first 72 hours and the entire population of the
-- overdue-breach report. The rule is one-directional: notification requires the
-- flag; the flag does not require notification.
--
-- WHY NULL CANNOT SATISFY THIS CHECK. Postgres treats a CHECK evaluating to NULL
-- as SATISFIED, so an implication written over a nullable column normally accepts
-- the exact row it means to reject. Both operands here are TOTAL predicates:
--
--   * `regulator_notified_at IS NULL` — `IS NULL` returns true or false for every
--     input including NULL. It is the one form that never propagates NULL, which
--     is why the antecedent is expressed as `IS NULL` rather than as a comparison.
--   * `personal_data_breach IS TRUE` — deliberately not `= true`. The column is
--     `boolean NOT NULL DEFAULT false` today, so `= true` would be safe today;
--     it would stop being safe the moment somebody dropped the NOT NULL, because
--     `NULL = true` is NULL, the OR of false and NULL is NULL, and the row would
--     pass. `IS TRUE` returns FALSE for NULL, so the constraint keeps refusing.
--
-- With both operands in {true, false}, the OR is in {true, false}: the expression
-- has no NULL result to be excused by, and the only rejected combination is
-- (regulator_notified_at IS NOT NULL, personal_data_breach IS NOT TRUE) — which is
-- the contradiction, exactly.
-- ============================================================================

-- Existing rows must be repaired first, or ADD CONSTRAINT fails validation with
-- SQLSTATE 23514 and takes every later migration down with it. Rows in this shape
-- are known to exist: the defect was reproduced against a running environment.
--
-- REPAIRED FORWARD — the flag is set, the timestamp is kept. `regulator_notified_at`
-- is evidence of something that HAPPENED outside this system: somebody filed an
-- Article 33 notification, and no UPDATE here makes that untrue. Clearing it to
-- satisfy the constraint would destroy the only record of the filing and, worse,
-- silently re-arm the 72-hour deadline on an incident already reported. The flag,
-- by contrast, is a classification the notification itself contradicts, so
-- restoring it is the repair that agrees with the evidence.
--
-- No timeline entry is appended for the repair: `incident_events.recorded_by` is
-- `uuid NOT NULL` and a migration has no identity to put there. The append-only
-- timeline already carries the 'Supervisory authority notified' entry the original
-- notification wrote, which is the evidence a reviewer needs; a synthetic row
-- attributed to nobody would be weaker than the one already there.
UPDATE isms.incidents
   SET personal_data_breach = true,
       updated_at = now()
 WHERE regulator_notified_at IS NOT NULL
   AND personal_data_breach IS NOT TRUE;

--> statement-breakpoint

-- DROP first, matching migration 0027: a re-run must not fail on
-- `duplicate_object`, and re-adding revalidates the table, which is the point.
ALTER TABLE isms.incidents
  DROP CONSTRAINT IF EXISTS ck_incident_breach_notification_pair;

ALTER TABLE isms.incidents
  ADD CONSTRAINT ck_incident_breach_notification_pair CHECK (
    regulator_notified_at IS NULL OR personal_data_breach IS TRUE
  );
