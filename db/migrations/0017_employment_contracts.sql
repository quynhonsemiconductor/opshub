-- ============================================================================
-- Migration 0017: employment contracts
-- ============================================================================
-- `employees` says who someone is and `employee_positions` says what role they
-- occupy. Neither says on what TERMS: whether the engagement ends, when probation
-- closes, what notice is owed, what the agreed pay is. Those are the questions HR
-- is actually asked, and none of them is answerable from a job title.
--
-- A contract is FOR a position, which is why 0016 came first. `position_id` is
-- nullable only because a contractor may be engaged for work rather than a seat.
--
-- THREE INVARIANTS HERE, ONE DELIBERATELY IN THE SERVICE
--
-- 1. ONE ACTIVE CONTRACT PER EMPLOYEE — `uq_employee_active_contract`, partial
--    unique over (employee_id) WHERE status = 'active'. Draft, expired and
--    terminated rows are unconstrained, so a renewal chain and an abandoned draft
--    coexist with the live agreement. This index is also what forces a renewal to
--    be one transaction: the incoming row cannot activate until the outgoing one
--    leaves 'active'.
--
-- 2. END DATE MATCHES TYPE — `ck_contract_type_end_date`. `permanent` with an end
--    date is a fixed-term contract mislabelled; `fixed_term` without one is
--    open-ended employment nobody approved. It reads one row, so it is a CHECK
--    rather than a service convention a seed could bypass.
--
-- 3. DATES RUN FORWARD — three CHECKs. An agreement that ended before it began is
--    a data-entry error, not a state.
--
-- NOT A CONSTRAINT, and not an oversight: "a contract may only be ACTIVATED once
-- it is signed" is a transition rule, not a property of a row. A CHECK on
-- (status='active' AND signed_at IS NOT NULL) would also forbid recording a
-- historical contract whose paperwork was never scanned. It lives in the service.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS contracts;

DO $$ BEGIN
  CREATE TYPE contract_type AS ENUM ('permanent', 'fixed_term', 'probation', 'internship', 'contractor');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE contract_status AS ENUM ('draft', 'active', 'expired', 'terminated');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE salary_period AS ENUM ('hourly', 'monthly', 'annual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS contracts.employment_contracts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id         uuid NOT NULL,
  position_id         uuid REFERENCES positions.positions (id) ON DELETE RESTRICT,
  reference           varchar(40) NOT NULL,
  contract_type       contract_type NOT NULL,
  start_date          date NOT NULL,
  end_date            date,
  probation_end_date  date,
  notice_period_days  integer NOT NULL DEFAULT 30,
  base_salary         numeric(14, 2),
  salary_currency     varchar(3),
  salary_period       salary_period,
  status              contract_status NOT NULL DEFAULT 'draft',
  signed_at           timestamptz,
  document_id         uuid,
  terminated_on       date,
  termination_reason  varchar(200),
  superseded_by_id    uuid,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  -- Invariant 2.
  CONSTRAINT ck_contract_type_end_date CHECK (
    (contract_type = 'permanent' AND end_date IS NULL)
    OR (contract_type <> 'permanent' AND end_date IS NOT NULL)
  ),

  -- Invariant 3, three ways.
  CONSTRAINT ck_contract_window
    CHECK (end_date IS NULL OR end_date >= start_date),
  CONSTRAINT ck_contract_probation_window
    CHECK (probation_end_date IS NULL OR probation_end_date >= start_date),
  CONSTRAINT ck_contract_terminated_window
    CHECK (terminated_on IS NULL OR terminated_on >= start_date),

  -- An amount with no currency or no period is not an amount. Kept together in one
  -- CHECK because the three columns are one fact.
  CONSTRAINT ck_contract_salary_complete CHECK (
    base_salary IS NULL
    OR (base_salary > 0 AND salary_currency IS NOT NULL AND salary_period IS NOT NULL)
  ),

  CONSTRAINT ck_contract_notice_non_negative CHECK (notice_period_days >= 0),

  -- A termination with no reason is a row nobody can account for later.
  CONSTRAINT ck_contract_termination_reason CHECK (
    (status = 'terminated') = (terminated_on IS NOT NULL AND termination_reason IS NOT NULL)
  ),

  -- A contract cannot succeed itself.
  CONSTRAINT ck_contract_not_self_superseded CHECK (superseded_by_id IS NULL OR superseded_by_id <> id)
);

-- Invariant 1.
CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_active_contract
  ON contracts.employment_contracts (employee_id)
  WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS uq_contract_reference
  ON contracts.employment_contracts (reference);

CREATE INDEX IF NOT EXISTS ix_contract_employee
  ON contracts.employment_contracts (employee_id, start_date);
CREATE INDEX IF NOT EXISTS ix_contract_position
  ON contracts.employment_contracts (position_id);
-- The expiry sweep's query: active contracts ordered by when they end.
CREATE INDEX IF NOT EXISTS ix_contract_status_end
  ON contracts.employment_contracts (status, end_date);

-- ============================================================================
-- Grants for the least-privilege roles
-- ============================================================================
-- Migration 0012 granted `opshub_app` / `opshub_worker` access by iterating the
-- schemas that existed THEN, so every schema added later needs this block. Local
-- development cannot catch the omission — a developer connects as the owner, which
-- is exempt — but CI runs its e2e suite as `opshub_app` and fails with a 500 on the
-- first insert, which is how migration 0015 found out.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_app') THEN
    GRANT USAGE ON SCHEMA contracts TO opshub_app, opshub_worker;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_migrate') THEN
      GRANT USAGE ON SCHEMA contracts TO opshub_migrate;
    END IF;

    GRANT SELECT, INSERT, UPDATE, DELETE
      ON ALL TABLES IN SCHEMA contracts TO opshub_app, opshub_worker;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA contracts TO opshub_app, opshub_worker;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_migrate') THEN
      GRANT ALL ON SCHEMA contracts TO opshub_migrate;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_migrate') THEN
      GRANT ALL ON ALL TABLES IN SCHEMA contracts TO opshub_migrate;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_migrate') THEN
      GRANT ALL ON ALL SEQUENCES IN SCHEMA contracts TO opshub_migrate;
    END IF;

    ALTER DEFAULT PRIVILEGES IN SCHEMA contracts
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO opshub_app, opshub_worker;
    ALTER DEFAULT PRIVILEGES IN SCHEMA contracts
      GRANT USAGE, SELECT ON SEQUENCES TO opshub_app, opshub_worker;
  END IF;
END $$;
