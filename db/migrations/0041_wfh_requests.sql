-- Work-from-home as a manager-approved request on the request engine (Workforce → WIO Calendar).
--
-- One row per request: a date range costed in WHOLE working days, a status the engine's hooks keep
-- in step with `request_items`. The shape mirrors `leave_requests` deliberately — the calendar, the
-- overlap rules and the review flow ask the same questions of both, and a second spelling of "a
-- dated request somebody approves" would drift from the first. No portions (WFH is whole days) and
-- no entitlement (WFH costs no allowance, so there is no balance to track).
--
-- The WIO calendar reads these live: an APPROVED window marks its working days as WFH, a PENDING
-- one shows as awaiting approval to the people allowed to see it, and being in the office remains
-- the default — no request, no mark.
--
-- Additive and idempotent. The enum is created under a guard rather than `IF NOT EXISTS` because
-- Postgres has no `IF NOT EXISTS` for types. The app and worker roles reach the table through the
-- default privileges migration 0012 set on this schema.

DO $$
BEGIN
  CREATE TYPE "public"."wfh_status" AS ENUM ('pending', 'approved', 'rejected', 'cancelled');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS workforce.wfh_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id  uuid NOT NULL,
  start_date   date NOT NULL,
  end_date     date NOT NULL,
  -- Working days the window covers, frozen at submit — the same rule as leave_requests.working_days.
  -- An integer column because WFH is whole days only.
  working_days integer NOT NULL,
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
