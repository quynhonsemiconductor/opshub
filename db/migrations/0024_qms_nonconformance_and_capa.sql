-- ============================================================================
-- Migration 0024: non-conformances and corrective actions (ISO 9001 §10.2)
-- ============================================================================
-- §10.2 is one obligation in five parts: react to the nonconformity, evaluate
-- whether corrective action is needed, implement it, REVIEW WHETHER IT WORKED, and
-- record both the nonconformity and the actions taken. So the register and the CAPA
-- table arrive together: the rule that makes the pair worth having — a major finding
-- cannot be closed until a CAPA has been verified effective — needs both to exist.
--
-- WHAT THIS IS NOT
--
-- `isms.incidents` is a SECURITY event whose states are what has been achieved under
-- time pressure. A non-conformance is a failure to meet a REQUIREMENT, which may have
-- caused no event at all. They overlap often enough that `nonconformances.incident_id`
-- exists, so an incident that also breaches a quality requirement is one finding with
-- a pointer rather than a retyped copy.
--
-- `compliance.compliance_findings` is scan-detected and always about software on a
-- device (`software_name` is NOT NULL there). It feeds this register; it is not this
-- register — the same conclusion migration 0019 reached about the same table.
--
-- WHY `nonconformance_severities` IS A TABLE
--
-- The third of this shape, after `isms.classification_levels` (0022) and
-- `isms.vendor_criticality_levels` (0023), and justified the same way twice over:
--
--   * The RANK cannot live in the enum's declaration order. Postgres does sort an
--     enum that way, so it appears to work until somebody appends a grade and
--     silently makes it the worst.
--   * `requires_capa` and `containment_due_days` are POLICY, read by the closure
--     gate and the overdue report. On the severity row they are stated once; in the
--     service they would be a CASE somebody has to remember to extend.
--
-- INVARIANTS
--
-- 1. EVERY FINDING HAS AN OWNER — `owner_id NOT NULL`.
--
-- 2. A STATE IS PAIRED WITH ITS EVIDENCE — `ck_nc_contained_pair`,
--    `ck_nc_closed_pair`, `ck_capa_*`. A `contained` row with no containment action
--    describes nothing; a `verified` CAPA with no verifier is not a review.
--
--    EVERY ONE OF THESE USES `coalesce(x, '')`. `length(btrim(NULL)) >= 10`
--    evaluates to NULL, and Postgres ACCEPTS a CHECK that returns NULL — so the
--    obvious spelling passes precisely the row it exists to reject, the one where the
--    column was left out. Migration 0023 shipped that bug in three constraints and it
--    was found by probing the real table with the column omitted, not by review.
--
-- 3. `void` CARRIES NOTHING — `ck_nc_void_clean`. "Raised in error" and "contained on
--    Tuesday" are not both true.
--
-- 4. TIME RUNS FORWARD — `ck_nc_timeline_order`, `ck_capa_timeline_order`.
--
-- 5. A CAPA BELONGS TO A FINDING — `nonconformance_id NOT NULL`. A corrective action
--    with nothing to correct cannot be reported on, and nobody can tell later whether
--    it worked.
--
-- WHAT THE SERVICE HOLDS THAT NO CHECK CAN
--
--   * THE CLOSURE GATE. A finding whose severity `requires_capa` cannot be closed
--     without a CAPA in state `verified` — a statement about rows in another table,
--     which is a query rather than a constraint.
--   * SEPARATION OF DUTIES on the effectiveness review: the verifier may not be the
--     CAPA owner. A CHECK could compare the two columns, but the rule is about the
--     ACTOR performing the transition, and the owner can change between plan and
--     review. It is enforced in the service and carries its own permission.
--   * `ineffective` RETURNS TO `analysis`. A CHECK cannot see the previous state.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS qms;

--> statement-breakpoint

CREATE TYPE nonconformance_source AS ENUM (
  'internal_audit',
  'external_audit',
  'customer_complaint',
  'process_monitoring',
  'employee_report',
  'supplier',
  'incident',
  'other'
);

CREATE TYPE nonconformance_severity AS ENUM ('observation', 'minor', 'major', 'critical');

CREATE TYPE nonconformance_status AS ENUM ('open', 'contained', 'closed', 'void');

CREATE TYPE capa_status AS ENUM (
  'analysis',
  'planned',
  'in_progress',
  'implemented',
  'verified',
  'ineffective',
  'cancelled'
);

CREATE TYPE capa_root_cause_method AS ENUM ('five_whys', 'fishbone', 'fault_tree', 'pareto', 'other');

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS qms.nonconformance_severities (
  code                 nonconformance_severity PRIMARY KEY,
  -- Higher is worse. THE authoritative ordering.
  rank                 smallint NOT NULL,
  label                varchar(60) NOT NULL,
  description          text NOT NULL,
  -- Read by the closure gate. The difference between a register and a to-do list.
  requires_capa        boolean NOT NULL,
  -- Days before an uncontained finding appears on the overdue report.
  containment_due_days integer NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  -- Ranks are a total order: two grades sharing one cannot be compared.
  CONSTRAINT uq_nc_severity_rank UNIQUE (rank),
  CONSTRAINT ck_nc_severity_rank CHECK (rank > 0),
  CONSTRAINT ck_nc_severity_containment_days CHECK (containment_due_days > 0)
);

--> statement-breakpoint

-- Seeded here rather than by the application seed: `nonconformances.severity` is an FK
-- to this table, so an empty table makes the register unusable. Reference data the
-- schema depends on, not fixtures.
--
-- The day counts are a starting policy, not a standard — ISO 9001 requires timely
-- action and leaves "timely" to the organisation.
INSERT INTO qms.nonconformance_severities
  (code, rank, label, description, requires_capa, containment_due_days)
VALUES
  ('observation', 1, 'Observation',
   'Not a breach yet. A practice that would fail if it continued, or a gap with no consequence '
   || 'so far. Recorded so it can be acted on before it becomes a finding — and closable on its '
   || 'own merits, because forcing a CAPA here is how observations stop being raised.',
   false, 30),
  ('minor', 2, 'Minor',
   'A single lapse against a requirement, with no evidence of systemic failure. Containment plus '
   || 'a recorded reason is enough to close it.',
   false, 14),
  ('major', 3, 'Major',
   'A requirement is not met in a way that recurs, affects the customer, or breaks a control the '
   || 'management system depends on. Cannot be closed without a corrective action verified '
   || 'effective.',
   true, 7),
  ('critical', 4, 'Critical',
   'Regulatory exposure, a safety consequence, or a failure that has reached the customer. '
   || 'Containment is immediate and a verified corrective action is mandatory.',
   true, 1)
ON CONFLICT (code) DO NOTHING;

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS qms.nonconformances (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Quoted in audit reports and CAPA records, e.g. `NC-2026-014`.
  reference             varchar(40) NOT NULL,
  title                 varchar(200) NOT NULL,
  description           text NOT NULL,
  -- The requirement that was not met. The field that separates a finding from a
  -- complaint: "the process says two approvals and one was recorded" against "the
  -- customer is unhappy", which is an INPUT to a finding.
  requirement           text NOT NULL,
  source                nonconformance_source NOT NULL,

  -- RESTRICT: a grade in use cannot be removed from underneath the findings on it.
  severity              nonconformance_severity NOT NULL
                          REFERENCES qms.nonconformance_severities (code) ON DELETE RESTRICT,
  status                nonconformance_status NOT NULL DEFAULT 'open',

  process_area          varchar(120) NOT NULL,

  -- No FK: `identity.employees` is a separate schema and every other cross-schema
  -- reference in this codebase is by id alone, so the service checks it.
  owner_id              uuid NOT NULL,
  detected_at           timestamptz NOT NULL DEFAULT now(),
  raised_by             uuid NOT NULL,

  -- SET NULL: closing an incident must not delete the quality finding about it.
  incident_id           uuid REFERENCES isms.incidents (id) ON DELETE SET NULL,
  evidence_document_id  uuid,

  containment_action    text,
  contained_at          timestamptz,

  closed_at             timestamptz,
  closure_note          text,
  closed_by             uuid,

  void_reason           text,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  -- Invariant 2. `coalesce` throughout — see the header.
  CONSTRAINT ck_nc_contained_pair CHECK (
    (contained_at IS NULL) = (length(btrim(coalesce(containment_action, ''))) < 10)
  ),
  -- Cumulative, so `closed` still carries the containment it passed through — an
  -- implication rather than an equivalence, matching `ck_incident_contained_pair`.
  CONSTRAINT ck_nc_contained_states CHECK (
    status NOT IN ('contained', 'closed') OR contained_at IS NOT NULL
  ),
  CONSTRAINT ck_nc_closed_pair CHECK (
    (status = 'closed')
    = (closed_at IS NOT NULL
       AND closed_by IS NOT NULL
       AND length(btrim(coalesce(closure_note, ''))) >= 10)
  ),
  -- Invariant 3.
  CONSTRAINT ck_nc_void_clean CHECK (
    status <> 'void'
    OR (contained_at IS NULL
        AND closed_at IS NULL
        AND length(btrim(coalesce(void_reason, ''))) >= 10)
  ),
  CONSTRAINT ck_nc_void_reason_only_when_void CHECK (
    void_reason IS NULL OR status = 'void'
  ),
  -- Invariant 4.
  CONSTRAINT ck_nc_timeline_order CHECK (
    (contained_at IS NULL OR contained_at >= detected_at)
    AND (closed_at IS NULL OR contained_at IS NULL OR closed_at >= contained_at)
    AND (closed_at IS NULL OR closed_at >= detected_at)
  ),
  -- A register whose entries say "x" cannot be handed to an auditor.
  CONSTRAINT ck_nc_title_substance CHECK (length(btrim(title)) >= 5),
  CONSTRAINT ck_nc_description_substance CHECK (length(btrim(description)) >= 10),
  CONSTRAINT ck_nc_requirement_substance CHECK (length(btrim(requirement)) >= 5),
  CONSTRAINT ck_nc_process_area_substance CHECK (length(btrim(process_area)) >= 2)
);

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS uq_nc_reference ON qms.nonconformances (reference);
CREATE INDEX IF NOT EXISTS ix_nc_status_severity ON qms.nonconformances (status, severity);
CREATE INDEX IF NOT EXISTS ix_nc_owner ON qms.nonconformances (owner_id);
-- "What keeps going wrong here?" — the recurrence report's query.
CREATE INDEX IF NOT EXISTS ix_nc_process_area ON qms.nonconformances (process_area);
CREATE INDEX IF NOT EXISTS ix_nc_detected ON qms.nonconformances (detected_at);
CREATE INDEX IF NOT EXISTS ix_nc_incident ON qms.nonconformances (incident_id);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS qms.capas (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference              varchar(40) NOT NULL,
  -- Invariant 5.
  nonconformance_id      uuid NOT NULL
                           REFERENCES qms.nonconformances (id) ON DELETE CASCADE,

  status                 capa_status NOT NULL DEFAULT 'analysis',
  owner_id               uuid NOT NULL,

  root_cause             text,
  root_cause_method      capa_root_cause_method,

  action_plan            text,
  due_on                 date,

  implemented_at         timestamptz,

  -- The effectiveness review, ISO 9001 §10.2(d).
  verified_at            timestamptz,
  verified_by            uuid,
  effectiveness_evidence text,

  outcome_note           text,

  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  -- Invariant 6. A plan built on no stated cause is a guess, so both the cause and
  -- the method it was established by are required past `analysis`.
  CONSTRAINT ck_capa_root_cause_states CHECK (
    status IN ('analysis', 'cancelled')
    OR (length(btrim(coalesce(root_cause, ''))) >= 10 AND root_cause_method IS NOT NULL)
  ),
  CONSTRAINT ck_capa_plan_states CHECK (
    status IN ('analysis', 'cancelled')
    OR length(btrim(coalesce(action_plan, ''))) >= 10
  ),
  CONSTRAINT ck_capa_implemented_states CHECK (
    status NOT IN ('implemented', 'verified', 'ineffective') OR implemented_at IS NOT NULL
  ),
  -- A review with no verifier and no evidence is not a review.
  CONSTRAINT ck_capa_verified_pair CHECK (
    (status = 'verified')
    = (verified_at IS NOT NULL
       AND verified_by IS NOT NULL
       AND length(btrim(coalesce(effectiveness_evidence, ''))) >= 10)
  ),
  -- A failed review and a cancellation both have to say why.
  CONSTRAINT ck_capa_outcome_note CHECK (
    status NOT IN ('ineffective', 'cancelled')
    OR length(btrim(coalesce(outcome_note, ''))) >= 10
  ),
  CONSTRAINT ck_capa_timeline_order CHECK (
    verified_at IS NULL OR implemented_at IS NULL OR verified_at >= implemented_at
  )
);

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS uq_capa_reference ON qms.capas (reference);
-- "What is outstanding against this finding?" — the closure gate's query.
CREATE INDEX IF NOT EXISTS ix_capa_nonconformance ON qms.capas (nonconformance_id, status);
CREATE INDEX IF NOT EXISTS ix_capa_owner ON qms.capas (owner_id);
CREATE INDEX IF NOT EXISTS ix_capa_due ON qms.capas (status, due_on);

--> statement-breakpoint

-- ============================================================================
-- Grants for the least-privilege roles
-- ============================================================================
-- A NEW SCHEMA, so this block does the full set — `USAGE`, the table grants, the
-- sequence grants, and `ALTER DEFAULT PRIVILEGES` so tables added to `qms` later
-- arrive usable. Migration 0012 iterated only the schemas that existed then; a new
-- schema that skips this surfaces as a permission error on the first insert in CI
-- rather than anything legible.
--
-- `nonconformance_severities` keeps SELECT only. The grades and their policy change by
-- migration, in review — not by whoever holds `nonconformance.manage`. Done with
-- REVOKE because `ALTER DEFAULT PRIVILEGES` below grants all four at CREATE TABLE and
-- a narrower GRANT would be a no-op that reads like a restriction (see 0022).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_app') THEN
    GRANT USAGE ON SCHEMA qms TO opshub_app, opshub_worker;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_migrate') THEN
      GRANT USAGE ON SCHEMA qms TO opshub_migrate;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_migrate') THEN
      GRANT ALL ON SCHEMA qms TO opshub_migrate;
    END IF;

    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA qms
      TO opshub_app, opshub_worker;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA qms TO opshub_app, opshub_worker;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_migrate') THEN
      GRANT ALL ON ALL TABLES IN SCHEMA qms TO opshub_migrate;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_migrate') THEN
      GRANT ALL ON ALL SEQUENCES IN SCHEMA qms TO opshub_migrate;
    END IF;

    ALTER DEFAULT PRIVILEGES IN SCHEMA qms
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO opshub_app, opshub_worker;
    ALTER DEFAULT PRIVILEGES IN SCHEMA qms
      GRANT USAGE, SELECT ON SEQUENCES TO opshub_app, opshub_worker;

    REVOKE INSERT, UPDATE, DELETE ON qms.nonconformance_severities
      FROM opshub_app, opshub_worker;
    GRANT SELECT ON qms.nonconformance_severities TO opshub_app, opshub_worker;
  END IF;
END $$;
