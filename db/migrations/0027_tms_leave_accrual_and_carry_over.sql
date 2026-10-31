-- ============================================================================
-- Migration 0027: leave accrual over time, and carry-over between years
-- ============================================================================
-- WHAT THIS DOES NOT ADD, AND WHY
--
-- No days-per-year column. `workforce.leave_entitlements.granted_days` is already
-- the year's entitlement — set by HR, pro-rated by hand for a mid-year joiner — and
-- two sources of truth for "how many days" is exactly the drift the balance service's
-- own docblock warns about. So the policy decides HOW those days become available and
-- WHAT survives into the next year, and nothing else.
--
-- No accrual ledger either. Accrued-to-date is a FUNCTION of the grant, the method
-- and the date, so it is computed on read for the same reason a balance is:
-- `granted × completed months ÷ 12` cannot drift, whereas a monthly cron writing rows
-- has to fire on the right morning twelve times a year and be reconciled when it does
-- not. The one thing that IS stored is what a carry-over run decided, because that is
-- a decision rather than arithmetic.
--
-- BEHAVIOUR-PRESERVING BY DEFAULT
--
-- A leave type with no policy row behaves exactly as it did before this migration:
-- `annual_grant`, no carry-over. That is why the seed below covers only the types
-- where accrual is a real policy, and why there is deliberately NO test asserting the
-- enum is fully covered — unlike `isms.classification_levels` and its siblings, an
-- absent row here is a MEANING and not a gap.
--
-- INVARIANTS
--
-- 1. AN EXPIRY NEEDS SOMETHING TO EXPIRE —
--    `ck_leave_policy_expiry_needs_carry_over`. An expiry month on a policy that
--    carries nothing forward describes nothing.
--
-- 2. AN EXPIRY DATE NEEDS CARRIED DAYS — `ck_leave_entitlement_expiry_pair`, the same
--    rule one table down. A date on a row that carried nothing is a lie about the row.
--
-- 3. DAYS ARE NOT NEGATIVE — `ck_leave_policy_carry_over_non_negative`,
--    `ck_leave_policy_expiry_months_range`. A negative cap would make the carry-over
--    run subtract days from next year.
--
-- WHAT THE SERVICE HOLDS THAT NO CHECK CAN
--
--   * ACCRUED-TO-DATE. A function of the date, so it is not a column at all.
--   * THE CARRY-OVER CAP. The cap lives on the policy and the carried days on the
--     entitlement, so a CHECK cannot compare them; the run applies it, and re-running
--     is idempotent because it SETS the value from the prior year rather than adding.
--   * EXPIRY. Carried days stop counting once `carried_over_expires_on` has passed,
--     which is a comparison against today and therefore a read-time decision.
-- ============================================================================

CREATE TYPE leave_accrual_method AS ENUM ('annual_grant', 'monthly_accrual');

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS workforce.leave_policies (
  leave_type               leave_type PRIMARY KEY,
  accrual_method           leave_accrual_method NOT NULL DEFAULT 'annual_grant',
  -- The most days that may be carried into the next year. `0` means none. A cap
  -- rather than a boolean because "carry over up to five days" is the shape every
  -- policy actually takes, and a boolean would put the number somewhere else.
  carry_over_max_days      numeric(5, 2) NOT NULL DEFAULT 0,
  -- How many months into the new year carried days survive. Null means never.
  carry_over_expiry_months integer,
  note                     text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  -- Invariant 3.
  CONSTRAINT ck_leave_policy_carry_over_non_negative CHECK (carry_over_max_days >= 0),
  CONSTRAINT ck_leave_policy_expiry_months_range CHECK (
    carry_over_expiry_months IS NULL OR carry_over_expiry_months BETWEEN 1 AND 12
  ),
  -- Invariant 1.
  CONSTRAINT ck_leave_policy_expiry_needs_carry_over CHECK (
    carry_over_expiry_months IS NULL OR carry_over_max_days > 0
  )
);

--> statement-breakpoint

-- Seeded for the types where accrual is a real policy. `unpaid` and `other` are
-- deliberately absent: they are untracked (no entitlement row), so a policy for them
-- would govern nothing. `sick` is present precisely to record that it does NOT carry
-- over, which is a decision worth being able to read.
INSERT INTO workforce.leave_policies
  (leave_type, accrual_method, carry_over_max_days, carry_over_expiry_months, note)
VALUES
  ('annual', 'monthly_accrual', 5, 6,
   'Annual leave is earned a twelfth of the year''s entitlement per completed month, so a leaver '
   || 'has taken no more than they earned. Up to five unused days carry into the next year and '
   || 'lapse after six months, which is long enough to plan around and short enough that a balance '
   || 'cannot compound year on year.'),
  ('sick', 'annual_grant', 0, NULL,
   'Sick leave is available in full from the first day of the year: somebody who falls ill in '
   || 'January has not earned less of it than somebody who falls ill in December. Nothing carries '
   || 'over — an unused sick allowance is not a saving.'),
  ('parental', 'annual_grant', 0, NULL,
   'Parental leave attaches to an event rather than to service accrued, so the whole entitlement '
   || 'is available when it is needed. Nothing carries over.')
ON CONFLICT (leave_type) DO NOTHING;

--> statement-breakpoint

-- Invariant 2, on the table that records what a carry-over run decided.
ALTER TABLE workforce.leave_entitlements
  ADD COLUMN IF NOT EXISTS carried_over_expires_on date;

--> statement-breakpoint

ALTER TABLE workforce.leave_entitlements
  DROP CONSTRAINT IF EXISTS ck_leave_entitlement_expiry_pair;

ALTER TABLE workforce.leave_entitlements
  ADD CONSTRAINT ck_leave_entitlement_expiry_pair CHECK (
    carried_over_expires_on IS NULL OR carried_over_days > 0
  );

--> statement-breakpoint

-- ============================================================================
-- Grants
-- ============================================================================
-- `workforce` was covered by migration 0012's blanket grants and default privileges,
-- so `leave_policies` arrives with SELECT/INSERT/UPDATE/DELETE for the application
-- roles. It is REFERENCE DATA, seeded above, so the write privileges are revoked:
-- accrual method and carry-over caps are policy, changed by migration and in review,
-- not by whoever holds `workforce.manage`.
--
-- Done with REVOKE and not a narrower GRANT, because the privileges attach at CREATE
-- TABLE from the default privileges — a smaller GRANT here would read like a
-- restriction and change nothing. See migration 0022.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_app') THEN
    REVOKE INSERT, UPDATE, DELETE ON workforce.leave_policies
      FROM opshub_app, opshub_worker;
    GRANT SELECT ON workforce.leave_policies TO opshub_app, opshub_worker;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_migrate') THEN
      GRANT ALL ON workforce.leave_policies TO opshub_migrate;
    END IF;
  END IF;
END $$;
