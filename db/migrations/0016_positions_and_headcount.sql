-- ============================================================================
-- Migration 0016: job positions, approved headcount, assignment history
-- ============================================================================
-- `employees` already carries `job_title` and `department`, but both are free text
-- ON THE PERSON. They answer "what does Mai do?" and nothing else: you cannot ask
-- how many QA Engineers were approved versus filled, what a vacancy is, or what
-- the role required when someone held it two years ago.
--
-- A position is the ROLE as an entity, outliving whoever occupies it. That is also
-- what the rest of the roadmap needs: QMS competency is "training required for
-- THIS POSITION", and an employment contract is a contract FOR a position. Built
-- against `job_title` both would be matching on a string.
--
-- `employees.job_title` is deliberately NOT dropped: the Entra sync writes it and
-- older screens read it. Removing it would be a second change riding along on this
-- one.
--
-- ONE INVARIANT IN THE DATABASE, ONE DELIBERATELY NOT
--
-- 1. ONE CURRENT POSITION PER EMPLOYEE — `uq_employee_current_position`, a partial
--    unique index over (employee_id) WHERE effective_to IS NULL. History rows are
--    unconstrained, so someone may hold the same position twice across a career,
--    but never two at once. That is what makes "their position" a question with
--    one answer, and no service check can hold it against concurrent writes.
--
-- 2. HEADCOUNT IS NOT A CONSTRAINT, and that is not an oversight. "At most
--    `headcount` open assignments for this position" is a COUNT across rows
--    filtered by `effective_to IS NULL`; a unique index cannot express it and a
--    CHECK cannot see other rows. It is enforced in the service, which counts
--    inside the assignment transaction so two concurrent assignments cannot both
--    see the last free slot.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS positions;

DO $$ BEGIN
  CREATE TYPE position_status AS ENUM ('active', 'frozen', 'closed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS positions.positions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         varchar(32) NOT NULL,
  title        varchar(160) NOT NULL,
  department   varchar(120) NOT NULL,
  level        varchar(40),
  headcount    integer NOT NULL DEFAULT 1,
  description  text,
  status       position_status NOT NULL DEFAULT 'active',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  -- A position that permits nobody is a deleted position expressed badly; `closed`
  -- is the state for that, and it keeps the occupancy history intact.
  CONSTRAINT ck_position_headcount_positive CHECK (headcount >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_position_code ON positions.positions (code);
CREATE INDEX IF NOT EXISTS ix_position_department ON positions.positions (department);
CREATE INDEX IF NOT EXISTS ix_position_status ON positions.positions (status);

CREATE TABLE IF NOT EXISTS positions.employee_positions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     uuid NOT NULL,
  position_id     uuid NOT NULL REFERENCES positions.positions (id) ON DELETE RESTRICT,
  effective_from  date NOT NULL,
  effective_to    date,
  end_reason      varchar(120),
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- An assignment that ended before it began is a data-entry error, not a state.
  CONSTRAINT ck_employee_position_window
    CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

-- Invariant 1.
CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_current_position
  ON positions.employee_positions (employee_id)
  WHERE effective_to IS NULL;

CREATE INDEX IF NOT EXISTS ix_employee_position_employee
  ON positions.employee_positions (employee_id, effective_from);
CREATE INDEX IF NOT EXISTS ix_employee_position_position
  ON positions.employee_positions (position_id);

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
    GRANT USAGE ON SCHEMA positions TO opshub_app, opshub_worker;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_migrate') THEN
      GRANT USAGE ON SCHEMA positions TO opshub_migrate;
    END IF;

    GRANT SELECT, INSERT, UPDATE, DELETE
      ON ALL TABLES IN SCHEMA positions TO opshub_app, opshub_worker;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA positions TO opshub_app, opshub_worker;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_migrate') THEN
      GRANT ALL ON SCHEMA positions TO opshub_migrate;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_migrate') THEN
      GRANT ALL ON ALL TABLES IN SCHEMA positions TO opshub_migrate;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_migrate') THEN
      GRANT ALL ON ALL SEQUENCES IN SCHEMA positions TO opshub_migrate;
    END IF;

    ALTER DEFAULT PRIVILEGES IN SCHEMA positions
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO opshub_app, opshub_worker;
    ALTER DEFAULT PRIVILEGES IN SCHEMA positions
      GRANT USAGE, SELECT ON SEQUENCES TO opshub_app, opshub_worker;
  END IF;
END $$;
