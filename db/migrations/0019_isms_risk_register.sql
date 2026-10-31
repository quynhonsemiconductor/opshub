-- ============================================================================
-- Migration 0019: ISMS risk register and treatment plans
-- ============================================================================
-- `compliance.compliance_findings` is shadow-IT specific — `software_name` is NOT
-- NULL and every row is something a scan detected. A risk is the opposite kind of
-- object: deliberately identified by a person, scored, owned, treated or accepted,
-- and reviewed on a cadence. Findings are INPUTS to risks, not risks.
--
-- SCORING IS GENERATED, NOT WRITTEN. `inherent_score` and `residual_score` are
-- `likelihood * impact` computed by Postgres, so the register cannot hold a row
-- whose score disagrees with its own factors — not by convention, by construction.
-- The seed and any fix-up script get it right for free, and the register's default
-- ordering is an indexed column rather than a recomputed expression.
--
-- INVARIANTS
--
-- 1. FACTORS ARE 1..5 — `ck_risk_inherent_range`, `ck_risk_residual_range`. A
--    5x5 matrix is what the policy documents; a 7 in one column silently changes
--    what every threshold in the register means.
--
-- 2. RESIDUAL IS BOTH OR NEITHER — `ck_risk_residual_pair`. A half-scored
--    residual is not a score, and the generated column would be NULL anyway,
--    which would then read as "not assessed".
--
-- 3. RESIDUAL CANNOT EXCEED INHERENT — `ck_risk_residual_not_worse`. Treatment
--    reduces risk or leaves it alone. A residual above inherent means the two
--    were entered the wrong way round.
--
-- 4. ACCEPTANCE IS ACCOUNTABLE — `ck_risk_accepted_evidence`. `accepted` requires
--    who, when and why. ISO 27001 asks exactly that, and a boolean answers none
--    of it. The approval itself is the request engine's, linked by
--    `accepted_via_request_id`.
--
-- 5. CLOSURE IS EXPLAINED — `ck_risk_closed_evidence`. A risk that left the
--    register with no reason is indistinguishable from one somebody deleted.
--
-- NOT A CONSTRAINT, deliberately: "a treated risk must have a residual score" is
-- a rule about the TRANSITION, so a CHECK cannot express it without also
-- forbidding a legitimate `identified` row that has no residual yet. It lives in
-- the service, alongside the guarded WHERE clause that makes it race-safe.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS isms;

DO $$ BEGIN
  CREATE TYPE risk_status AS ENUM ('identified', 'assessed', 'treated', 'accepted', 'closed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE risk_treatment_decision AS ENUM ('mitigate', 'accept', 'transfer', 'avoid');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE risk_treatment_status AS ENUM ('planned', 'in_progress', 'done', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS isms.risks (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference                varchar(40) NOT NULL,
  title                    varchar(200) NOT NULL,
  description              text NOT NULL,
  category                 varchar(64) NOT NULL,
  -- SET NULL, not CASCADE: retiring a laptop must not delete the assessment that
  -- mentioned it, because the assessment and its acceptance are audit evidence.
  asset_id                 uuid REFERENCES assets.assets (id) ON DELETE SET NULL,
  owner_id                 uuid NOT NULL,

  inherent_likelihood      integer NOT NULL,
  inherent_impact          integer NOT NULL,
  inherent_score           integer GENERATED ALWAYS AS (inherent_likelihood * inherent_impact) STORED,

  treatment_decision       risk_treatment_decision,
  residual_likelihood      integer,
  residual_impact          integer,
  residual_score           integer GENERATED ALWAYS AS (residual_likelihood * residual_impact) STORED,

  status                   risk_status NOT NULL DEFAULT 'identified',
  review_due_on            date,

  accepted_by              uuid,
  accepted_at              timestamptz,
  acceptance_justification text,
  accepted_via_request_id  uuid,

  closed_at                timestamptz,
  closure_note             varchar(300),

  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  -- The 1..5 bounds are mirrored in `libs/modules/isms/src/domain/rating.ts`, which is the
  -- single source for the application layer. SQL cannot import it, so this is the one
  -- remaining copy — changing the scale means changing both, plus
  -- `ACCEPTANCE_APPROVAL_THRESHOLD`, which is expressed in scale units.
  CONSTRAINT ck_risk_inherent_range CHECK (
    inherent_likelihood BETWEEN 1 AND 5 AND inherent_impact BETWEEN 1 AND 5
  ),
  CONSTRAINT ck_risk_residual_range CHECK (
    (residual_likelihood IS NULL OR residual_likelihood BETWEEN 1 AND 5)
    AND (residual_impact IS NULL OR residual_impact BETWEEN 1 AND 5)
  ),
  CONSTRAINT ck_risk_residual_pair CHECK (
    (residual_likelihood IS NULL) = (residual_impact IS NULL)
  ),
  -- Compares the FACTORS rather than the generated columns: a CHECK may not
  -- reference a generated column in Postgres.
  CONSTRAINT ck_risk_residual_not_worse CHECK (
    residual_likelihood IS NULL
    OR residual_likelihood * residual_impact <= inherent_likelihood * inherent_impact
  ),
  CONSTRAINT ck_risk_accepted_evidence CHECK (
    (status = 'accepted') = (
      accepted_by IS NOT NULL AND accepted_at IS NOT NULL AND acceptance_justification IS NOT NULL
    )
  ),
  CONSTRAINT ck_risk_closed_evidence CHECK (
    (status = 'closed') = (closed_at IS NOT NULL AND closure_note IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_risk_reference ON isms.risks (reference);
-- The register's default view: worst first.
CREATE INDEX IF NOT EXISTS ix_risk_status_score ON isms.risks (status, inherent_score);
CREATE INDEX IF NOT EXISTS ix_risk_owner ON isms.risks (owner_id);
CREATE INDEX IF NOT EXISTS ix_risk_asset ON isms.risks (asset_id);
-- The review-due report's query.
CREATE INDEX IF NOT EXISTS ix_risk_review_due ON isms.risks (status, review_due_on);

CREATE TABLE IF NOT EXISTS isms.risk_treatments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  risk_id       uuid NOT NULL REFERENCES isms.risks (id) ON DELETE CASCADE,
  description   text NOT NULL,
  -- Separate from the risk owner: the owner is ACCOUNTABLE, this one is assigned.
  owner_id      uuid NOT NULL,
  due_on        date,
  status        risk_treatment_status NOT NULL DEFAULT 'planned',
  completed_on  date,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- `done` and a completion date are one fact.
  CONSTRAINT ck_treatment_done_evidence CHECK ((status = 'done') = (completed_on IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS ix_risk_treatment_risk ON isms.risk_treatments (risk_id, status);
CREATE INDEX IF NOT EXISTS ix_risk_treatment_owner ON isms.risk_treatments (owner_id);
CREATE INDEX IF NOT EXISTS ix_risk_treatment_due ON isms.risk_treatments (status, due_on);

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
    GRANT USAGE ON SCHEMA isms TO opshub_app, opshub_worker;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_migrate') THEN
      GRANT USAGE ON SCHEMA isms TO opshub_migrate;
    END IF;

    GRANT SELECT, INSERT, UPDATE, DELETE
      ON ALL TABLES IN SCHEMA isms TO opshub_app, opshub_worker;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA isms TO opshub_app, opshub_worker;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_migrate') THEN
      GRANT ALL ON SCHEMA isms TO opshub_migrate;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_migrate') THEN
      GRANT ALL ON ALL TABLES IN SCHEMA isms TO opshub_migrate;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_migrate') THEN
      GRANT ALL ON ALL SEQUENCES IN SCHEMA isms TO opshub_migrate;
    END IF;

    ALTER DEFAULT PRIVILEGES IN SCHEMA isms
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO opshub_app, opshub_worker;
    ALTER DEFAULT PRIVILEGES IN SCHEMA isms
      GRANT USAGE, SELECT ON SEQUENCES TO opshub_app, opshub_worker;
  END IF;
END $$;
