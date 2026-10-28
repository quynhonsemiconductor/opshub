-- Attendance core: manager-approved justifications and the month close (owner rules 2026-10-28).
--
-- THE DAY ITSELF IS NOT STORED. Status, worked minutes and flags are DERIVED at read time from the
-- door swipes plus the live leave/WFH/justification requests, so there is no per-day table to keep
-- in step and no second copy of a day to disagree with the first. Two small tables are all this
-- needs:
--
--   attendance_justifications — one row per request, engine-synced like leave/WFH. A justification
--   does not spend a day, it EXPLAINS one, so it coexists with leave and WFH instead of competing
--   with them: an approved row credits its working days and clears their flags. Status reuses the
--   wfh_status enum (pending/approved/rejected/cancelled): expiry is `cancelled` for the same
--   reason WFH's is — nobody answering is not a refusal.
--
--   attendance_month_closes — one row per closed month. Presence of a row IS the lock; HR closes,
--   and only the administrator wildcard can reopen (the audited override).
--
-- Additive and idempotent, same style as 0041/0042. The app and worker roles reach both tables
-- through the default privileges migration 0012 set on this schema.

CREATE TYPE "public"."attendance_justification_kind" AS ENUM ('late', 'early', 'forgot_card', 'missing_checkout');

CREATE TABLE IF NOT EXISTS workforce.attendance_justifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id  uuid NOT NULL,
  start_date   date NOT NULL,
  end_date     date NOT NULL,
  -- Working days the window covers, frozen at submit — same rule as leave/WFH.
  working_days numeric(5,2) NOT NULL,
  kind         attendance_justification_kind NOT NULL,
  reason       text,
  status       wfh_status NOT NULL DEFAULT 'pending',
  reviewer_id  uuid,
  reviewed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  request_id   uuid REFERENCES requests.request_items (id) ON DELETE SET NULL,
  CONSTRAINT ck_attendance_just_dates CHECK (end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS ix_attendance_just_employee
  ON workforce.attendance_justifications (employee_id, start_date);
CREATE INDEX IF NOT EXISTS ix_attendance_just_status
  ON workforce.attendance_justifications (status);

CREATE TABLE IF NOT EXISTS workforce.attendance_month_closes (
  -- The month IS the key: one row per closed month, its presence the lock.
  month      varchar(7) PRIMARY KEY,
  closed_by  uuid NOT NULL,
  closed_at  timestamptz NOT NULL DEFAULT now(),
  note       text
);
