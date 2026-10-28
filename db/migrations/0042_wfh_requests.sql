-- Work-from-home as a request, not a self-tick (Workforce → WIO Calendar).
--
-- `0041_wfh_days` let each person tick their own WFH days. The owner rules of 2026-10-28 make every
-- non-office day a manager-approved request on the same engine as leave and overtime, so the tick
-- table is replaced by `workforce.wfh_requests`: one row per request, a date range costed in working
-- days, a status the engine's hooks keep in step with `request_items`.
--
-- The shape mirrors `leave_requests` deliberately: the calendar, the overlap rules and the review
-- flow ask the same questions of both, and a second spelling of "a dated request somebody approves"
-- would drift from the first. No portions — WFH is whole days only; half-day WFH is not a thing the
-- rules define. No entitlement — WFH costs no allowance, so there is no balance to track.
--
-- `wfh_days` never reached production: it shipped in 0041 on this same branch series, and the only
-- databases that ran it are develop. Dropping it here (rather than editing 0041) keeps the journal
-- linear for every database that already applied 0041.
--
-- Additive and idempotent, same style as 0041: safe with the old api still running. The app and
-- worker roles reach the new table through the default privileges migration 0012 set on this schema.

CREATE TYPE "public"."wfh_status" AS ENUM ('pending', 'approved', 'rejected', 'cancelled');

CREATE TABLE IF NOT EXISTS workforce.wfh_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id  uuid NOT NULL,
  start_date   date NOT NULL,
  end_date     date NOT NULL,
  -- Working days the window covers, frozen at submit — the same rule as leave_requests.working_days.
  working_days numeric(5,2) NOT NULL,
  reason       text,
  status       wfh_status NOT NULL DEFAULT 'pending',
  reviewer_id  uuid,
  reviewed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  request_id   uuid REFERENCES requests.request_items (id) ON DELETE SET NULL,
  CONSTRAINT ck_wfh_dates CHECK (end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS ix_wfh_employee ON workforce.wfh_requests (employee_id, start_date);
CREATE INDEX IF NOT EXISTS ix_wfh_status ON workforce.wfh_requests (status);

DROP TABLE IF EXISTS workforce.wfh_days;
