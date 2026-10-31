-- ============================================================================
-- Migration 0020: control catalogue, Statement of Applicability, risk↔control link
-- ============================================================================
-- THREE TABLES, BECAUSE THEY ANSWER THREE DIFFERENT QUESTIONS
--
--   isms.controls      REFERENCE DATA. What Annex A contains, plus the
--                      organisation's own additions. Says nothing about this
--                      company; two organisations hold identical rows.
--
--   isms.soa_entries   The DECISION about each control — applicable or not, why,
--                      how far implemented, who owns it, when it is reviewed.
--                      That is the Statement of Applicability, the one document an
--                      ISO 27001 auditor asks for first. ONE row per control:
--                      `uq_soa_control`, because a statement that says two things
--                      says nothing.
--
--   isms.risk_controls WHICH CONTROLS TREAT WHICH RISK. Many-to-many by nature,
--                      and the join is what turns "we have controls" into "this
--                      risk is treated by these controls".
--
-- WHY NOT COLUMNS ON `controls`. Merging the decision into the catalogue would let
-- a re-seed of Annex A overwrite the organisation's justifications, and it would
-- make "which controls have we not decided about yet?" unanswerable — an ABSENT
-- SoA row is precisely that state, and a NULL column cannot distinguish it from
-- "decided, no comment".
--
-- INVARIANTS
--
-- 1. APPLICABILITY AND STATUS CANNOT DISAGREE — `ck_soa_applicability` pairs
--    `applicable = false` with `not_applicable`. "Excluded but implemented" is
--    unrepresentable rather than merely discouraged, and so is "included but not
--    applicable".
--
-- 2. A JUSTIFICATION IS ALWAYS PRESENT — `justification` is NOT NULL and
--    `ck_soa_justification_substance` requires more than whitespace. For an
--    included control it is the rationale; for an excluded one it is the exclusion
--    reason the standard demands by name. One column, because it is one
--    obligation.
--
-- NOT CONSTRAINTS, deliberately. "An implemented control should have evidence" is
-- a maturity judgement, not a data rule. Plenty of controls are implemented by
-- configuration rather than by a document, and a CHECK would push people into
-- attaching the nearest file to satisfy it. The gap report surfaces it instead.
-- ============================================================================

DO $$ BEGIN
  CREATE TYPE control_theme AS ENUM ('organizational', 'people', 'physical', 'technological');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE control_source AS ENUM ('annex_a', 'custom');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE control_implementation_status AS ENUM (
    'not_applicable', 'not_implemented', 'partially_implemented', 'implemented'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS isms.controls (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference    varchar(40) NOT NULL,
  title        varchar(300) NOT NULL,
  description  text,
  theme        control_theme NOT NULL,
  source       control_source NOT NULL DEFAULT 'annex_a',
  -- Retired controls stay: an SoA entry from last year's audit references one by
  -- id, and deleting it would orphan the evidence.
  retired_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_control_reference ON isms.controls (reference);
CREATE INDEX IF NOT EXISTS ix_control_theme ON isms.controls (theme);

CREATE TABLE IF NOT EXISTS isms.soa_entries (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  control_id            uuid NOT NULL REFERENCES isms.controls (id) ON DELETE RESTRICT,
  applicable            boolean NOT NULL,
  justification         text NOT NULL,
  status                control_implementation_status NOT NULL,
  implementation_note   text,
  evidence_document_id  uuid,
  owner_id              uuid,
  last_reviewed_at      timestamptz,
  review_due_on         date,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  -- Invariant 1.
  CONSTRAINT ck_soa_applicability CHECK ((applicable = false) = (status = 'not_applicable')),
  -- Invariant 2. `btrim` rather than a length check on the raw value: 20 spaces is
  -- not a justification, and that is exactly what gets typed to get past one.
  CONSTRAINT ck_soa_justification_substance CHECK (length(btrim(justification)) >= 10)
  -- There is deliberately NO constraint pairing `last_reviewed_at` with
  -- `review_due_on`. The first draft of this migration carried one, and it read
  -- `a IS NOT NULL OR b IS NOT NULL OR TRUE` — a tautology that can never fail, so
  -- it would have sat here looking like a guarantee while enforcing nothing. The
  -- two columns are genuinely independent: an entry may be reviewed with no next
  -- date set, or scheduled before it has ever been reviewed.
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_soa_control ON isms.soa_entries (control_id);
CREATE INDEX IF NOT EXISTS ix_soa_status ON isms.soa_entries (applicable, status);
CREATE INDEX IF NOT EXISTS ix_soa_owner ON isms.soa_entries (owner_id);
CREATE INDEX IF NOT EXISTS ix_soa_review_due ON isms.soa_entries (review_due_on);

CREATE TABLE IF NOT EXISTS isms.risk_controls (
  risk_id     uuid NOT NULL REFERENCES isms.risks (id) ON DELETE CASCADE,
  control_id  uuid NOT NULL REFERENCES isms.controls (id) ON DELETE RESTRICT,
  linked_by   uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- The same control linked twice to one risk is still one link.
  CONSTRAINT risk_controls_pkey PRIMARY KEY (risk_id, control_id)
);

-- "Which risks does this control treat?" — the direction an SoA justification needs.
CREATE INDEX IF NOT EXISTS ix_risk_control_control ON isms.risk_controls (control_id);

-- ============================================================================
-- Grants for the least-privilege roles
-- ============================================================================
-- The `isms` schema already carries `ALTER DEFAULT PRIVILEGES` from migration 0019,
-- so tables created here by the same owner inherit them. Granted EXPLICITLY anyway:
-- default privileges apply only when the creating role matches, and a mismatch
-- surfaces as a 500 on the first insert in CI rather than anything legible.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON isms.controls, isms.soa_entries, isms.risk_controls TO opshub_app, opshub_worker;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_migrate') THEN
      GRANT ALL
        ON isms.controls, isms.soa_entries, isms.risk_controls TO opshub_migrate;
    END IF;
  END IF;
END $$;
