-- ============================================================================
-- Migration 0025: internal audit engagements (ISO 9001 §9.2)
-- ============================================================================
-- WHY THE FINDINGS ARE NOT A TABLE HERE
--
-- An audit finding IS a non-conformance. `qms.nonconformances.source` already
-- carries `internal_audit`, and §9.2.2(e) — action without undue delay — is the
-- CAPA machinery migration 0024 built. A separate `audit_findings` table would
-- duplicate the grade, the containment, the closure gate and the CAPA link, and the
-- two copies would immediately disagree about what "closed" means. So the audit
-- gains a pointer FROM the register and nothing else.
--
-- `nonconformances.internal_audit_id` is NULLABLE and is NOT required even when
-- `source = 'internal_audit'`. A finding written up during fieldwork before the
-- engagement row exists is the normal order of events for a small team, and a
-- blanket requirement would push that record-keeping out of the system. The gap is
-- a REPORT instead — the same reasoning as the risk register's unlinked incidents
-- and the vendor register's unassessed spend.
--
-- WHAT §9.2 ASKS FOR, AND WHERE EACH PART LIVES
--
--   (b) define the CRITERIA and SCOPE of each audit — both NOT NULL with substance
--       CHECKs. An audit with no stated criteria cannot be repeated or defended, and
--       "we looked at purchasing" is not an audit scope.
--   (c) ensure OBJECTIVITY and IMPARTIALITY — `internal_audit_auditors`, plus the
--       rule enforced in `CapaService`: somebody who audited may not sign off the
--       effectiveness of a corrective action arising from their own finding. That
--       one is a statement about rows in three tables, so no CHECK can hold it.
--   (d) REPORT results to relevant management — the `reported` state, requiring a
--       conclusion AND the report document to reach it.
--   (f) RETAIN documented evidence — rows are never deleted. `cancelled` records an
--       audit that did not happen, and says why.
--
-- INVARIANTS
--
-- 1. EVERY AUDIT HAS A LEAD — `lead_auditor_id NOT NULL`, and the service also
--    writes the matching `lead` roster row inside the same transaction so the
--    column and the roster cannot disagree.
--
-- 2. A STATE CARRIES ITS OWN EVIDENCE — `ck_audit_started_states`,
--    `ck_audit_reported_pair`, `ck_audit_closed_states`, `ck_audit_cancelled_pair`.
--    Every one uses `coalesce(x, '')`: a CHECK that evaluates to NULL is SATISFIED,
--    so the naive spelling accepts precisely the row where the column was omitted
--    (migration 0023 shipped that bug three times).
--
-- 3. REPORTING IS NOT OPTIONAL BEFORE CLOSURE — `ck_audit_closed_states` requires
--    `reported_at`. An audit closed without its results reaching management has not
--    been done, whatever the status column says.
--
-- 4. TIME RUNS FORWARD — `ck_audit_timeline_order`.
--
-- 5. THE PLANNED WINDOW RUNS FORWARD — `ck_audit_planned_window`, fronted by the
--    shared `assertDateOrder` guard so the caller gets a code, not a 500.
-- ============================================================================

CREATE TYPE internal_audit_status AS ENUM (
  'planned',
  'in_progress',
  'reported',
  'closed',
  'cancelled'
);

-- `observer` exists so somebody being trained, or an auditee's representative
-- sitting in, is recorded WITHOUT counting as an auditor — which matters, because
-- the impartiality rule keys off who actually audited.
CREATE TYPE audit_role AS ENUM ('lead', 'auditor', 'observer');

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS qms.internal_audits (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Quoted in the audit programme and in every finding it raises, e.g. `IA-2026-03`.
  reference          varchar(40) NOT NULL,
  title              varchar(200) NOT NULL,
  -- What the audit set out to establish.
  objective          text NOT NULL,
  -- Which processes, sites and periods it covers — §9.2.2(b).
  scope              text NOT NULL,
  -- The requirements audited AGAINST. Separate from `scope` because they answer
  -- different questions: scope is where you looked, criteria is what you judged by.
  criteria           text NOT NULL,

  status             internal_audit_status NOT NULL DEFAULT 'planned',

  -- No FK: `identity.employees` is a separate schema and every other cross-schema
  -- reference in this codebase is by id alone, so the service checks it.
  lead_auditor_id    uuid NOT NULL,

  planned_start_on   date,
  planned_end_on     date,
  started_at         timestamptz,

  reported_at        timestamptz,
  conclusion         text,
  report_document_id uuid,

  closed_at          timestamptz,
  cancel_reason      text,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  -- Invariant 2. Cumulative: a reported or closed audit still carries the
  -- `started_at` it passed through, so these are implications, not equivalences.
  CONSTRAINT ck_audit_started_states CHECK (
    status NOT IN ('in_progress', 'reported', 'closed') OR started_at IS NOT NULL
  ),
  -- Reporting needs BOTH a conclusion and the report document. An equivalence, so
  -- the fields cannot be populated on an audit that has not reported.
  CONSTRAINT ck_audit_reported_pair CHECK (
    (status IN ('reported', 'closed'))
    = (reported_at IS NOT NULL
       AND report_document_id IS NOT NULL
       AND length(btrim(coalesce(conclusion, ''))) >= 10)
  ),
  -- Invariant 3.
  CONSTRAINT ck_audit_closed_states CHECK (
    (status = 'closed') = (closed_at IS NOT NULL)
  ),
  -- Invariant 2, for the state that records an audit which did not happen.
  CONSTRAINT ck_audit_cancelled_pair CHECK (
    (status = 'cancelled') = (length(btrim(coalesce(cancel_reason, ''))) >= 10)
  ),
  -- A cancelled audit reported nothing and closed nothing.
  CONSTRAINT ck_audit_cancelled_clean CHECK (
    status <> 'cancelled' OR (reported_at IS NULL AND closed_at IS NULL)
  ),
  -- Invariant 4.
  CONSTRAINT ck_audit_timeline_order CHECK (
    (reported_at IS NULL OR started_at IS NULL OR reported_at >= started_at)
    AND (closed_at IS NULL OR reported_at IS NULL OR closed_at >= reported_at)
  ),
  -- Invariant 5. Inclusive, matching the shared `assertDateOrder` guard.
  CONSTRAINT ck_audit_planned_window CHECK (
    planned_start_on IS NULL
    OR planned_end_on IS NULL
    OR planned_end_on >= planned_start_on
  ),
  -- An audit whose scope or criteria say "x" cannot be repeated or defended.
  CONSTRAINT ck_audit_title_substance CHECK (length(btrim(title)) >= 5),
  CONSTRAINT ck_audit_objective_substance CHECK (length(btrim(objective)) >= 10),
  CONSTRAINT ck_audit_scope_substance CHECK (length(btrim(scope)) >= 10),
  CONSTRAINT ck_audit_criteria_substance CHECK (length(btrim(criteria)) >= 5)
);

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS uq_internal_audit_reference
  ON qms.internal_audits (reference);
CREATE INDEX IF NOT EXISTS ix_internal_audit_status ON qms.internal_audits (status);
CREATE INDEX IF NOT EXISTS ix_internal_audit_lead ON qms.internal_audits (lead_auditor_id);
-- The programme view: what is planned when.
CREATE INDEX IF NOT EXISTS ix_internal_audit_planned
  ON qms.internal_audits (planned_start_on);

--> statement-breakpoint

-- Who audited, and in what capacity — §9.2.2(c). A table rather than a column
-- because an audit is a team activity, and because the IMPARTIALITY rule needs the
-- full set: it asks "did this person audit here", which a single `lead_auditor_id`
-- cannot answer for the auditor who did the fieldwork.
CREATE TABLE IF NOT EXISTS qms.internal_audit_auditors (
  internal_audit_id uuid NOT NULL
                      REFERENCES qms.internal_audits (id) ON DELETE CASCADE,
  auditor_id        uuid NOT NULL,
  role              audit_role NOT NULL DEFAULT 'auditor',
  added_by          uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),

  -- Natural key: one person holds one role on one audit.
  CONSTRAINT pk_internal_audit_auditor PRIMARY KEY (internal_audit_id, auditor_id)
);

--> statement-breakpoint

-- "What has this person audited?" — the direction the impartiality rule reads from.
CREATE INDEX IF NOT EXISTS ix_internal_audit_auditor_person
  ON qms.internal_audit_auditors (auditor_id);

--> statement-breakpoint

-- ============================================================================
-- The finding's pointer back to the audit that raised it
-- ============================================================================
-- SET NULL rather than CASCADE: an audit is never deleted, but if one ever were,
-- the finding and its CAPA are the audit evidence and must outlive it.
ALTER TABLE qms.nonconformances
  ADD COLUMN IF NOT EXISTS internal_audit_id uuid
    REFERENCES qms.internal_audits (id) ON DELETE SET NULL;

--> statement-breakpoint

-- The audit's own finding list, and the unlinked-findings report's anti-join.
CREATE INDEX IF NOT EXISTS ix_nc_internal_audit
  ON qms.nonconformances (internal_audit_id);

--> statement-breakpoint

-- ============================================================================
-- Grants
-- ============================================================================
-- `qms` already carries `ALTER DEFAULT PRIVILEGES` from migration 0024, so both new
-- tables arrive with SELECT/INSERT/UPDATE/DELETE for the application roles and need
-- no grant here. Stated rather than omitted, because the absence of a grant block in
-- a migration that creates tables is otherwise indistinguishable from forgetting one.
--
-- Nothing here is reference data and nothing here is append-only, so there is no
-- REVOKE either: the roster is edited (an auditor is swapped before fieldwork) and
-- the engagement is edited throughout its life.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_app') THEN
    -- Belt and braces: if 0024's ALTER DEFAULT PRIVILEGES were ever reverted, these
    -- tables would still be usable rather than failing on the first insert in CI.
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON qms.internal_audits, qms.internal_audit_auditors
      TO opshub_app, opshub_worker;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_migrate') THEN
      GRANT ALL ON qms.internal_audits, qms.internal_audit_auditors TO opshub_migrate;
    END IF;
  END IF;
END $$;
