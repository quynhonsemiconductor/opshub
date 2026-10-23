-- Work-from-home days for the WIO calendar (Workforce → WIO Calendar).
--
-- One row = "this employee works from home on this date". A day with NO row is a day in the office, so the
-- default needs no seeding, no backfill for new joiners and no job that keeps future days filled in; marking a
-- day back to the office deletes its row.
--
-- (employee_id, work_date) is unique, so a double click or a second tab cannot mark a day twice. The date index
-- serves the calendar's one query: every employee's marks for a month.
--
-- Additive and idempotent: one new table, no change to an existing one, safe with the old api still running.
-- The app and worker roles reach it through the default privileges migration 0012 set on this schema.

CREATE TABLE IF NOT EXISTS workforce.wfh_days (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id  uuid NOT NULL,
  work_date    date NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_wfh_employee_date
  ON workforce.wfh_days (employee_id, work_date);
CREATE INDEX IF NOT EXISTS ix_wfh_date
  ON workforce.wfh_days (work_date);
