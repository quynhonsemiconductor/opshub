-- ============================================================================
-- Migration 0021: security incidents and their append-only timeline
-- ============================================================================
-- AN INCIDENT IS A RISK THAT MATERIALISED, which is why `risk_id` exists: the
-- register said this could happen and the incident proves it did. Nullable,
-- because plenty of incidents are things nobody had on the register — and
-- noticing THAT is the feedback loop, surfaced by a report rather than by forcing
-- a link nobody believes.
--
-- WHY NOT THE REQUEST ENGINE. Every other multi-step flow here is a
-- `RequestTypeDef`, and the roadmap warns against modules growing their own status
-- columns. This is the deliberate exception: the engine models an APPROVAL —
-- somebody decides yes or no, with separation of duties and an SLA on the
-- decision. Incident handling is not a decision awaiting approval; it is work
-- proceeding under time pressure, and its states are what has been ACHIEVED
-- (contained, resolved) rather than what has been permitted. Routing it through
-- the engine would require an approver for "we have contained it".
--
-- INVARIANTS
--
-- 1. TIMESTAMPS ARE PAIRED WITH STATUS — `ck_incident_contained_pair`,
--    `ck_incident_resolved_pair`, `ck_incident_closed_pair`. A `contained_at` on
--    something still `triaged` is a lie, and a `resolved` row with no
--    `resolved_at` cannot be reported on.
--
--    Each is written as an implication rather than an equivalence, because the
--    states are CUMULATIVE: a `closed` incident still carries the `contained_at`
--    and `resolved_at` it passed through. So "contained_at IS NOT NULL" is
--    required BY the later states, not forbidden to them.
--
-- 2. TIME RUNS FORWARD — `ck_incident_timeline_order`. Resolved before detected,
--    or closed before resolved, is a data-entry error rather than a state.
--
-- 3. RESOLVING NEEDS A CAUSE, CLOSING NEEDS A LESSON —
--    `ck_incident_resolution_evidence`, `ck_incident_closure_evidence`. ISO 27001
--    A.5.27 is "learning from information security incidents"; a closed incident
--    with nothing learned is the box-ticking the clause exists to prevent.
--
-- 4. `false_positive` IS TERMINAL AND CARRIES NO HANDLING TIMESTAMPS —
--    `ck_incident_false_positive`. "It turned out not to be an incident" is a real
--    outcome, and forcing it through contained/resolved would attach containment
--    times to something that never needed containing.
--
-- THE 72-HOUR CLOCK IS DERIVED IN THE QUERY, NOT STORED — and that is a
-- correction, not a preference. It was first written as a generated column,
-- `detected_at + interval '72 hours'`, which Postgres refuses:
--
--     ERROR 42P17: generation expression is not immutable
--
-- Adding an interval to a `timestamptz` is only STABLE, because the result depends
-- on the session time zone and therefore on DST; a generated column requires
-- IMMUTABLE. Rather than fight that with `AT TIME ZONE` casts, the deadline lives
-- in ONE place — the repository's overdue query — and the partial index below
-- covers `detected_at`, which is what that query filters and orders on. GDPR
-- Article 33 counts 72 hours from becoming aware, so detection is the anchor
-- either way.
--
-- THE TIMELINE IS APPEND-ONLY. `incident_events` gets no UPDATE or DELETE path in
-- the service, and the reason is evidential: a post-incident review is read by
-- people judging whether the handling was adequate, and a timeline that can be
-- quietly edited afterwards proves nothing. Corrections are new rows.
-- ============================================================================

DO $$ BEGIN
  CREATE TYPE incident_status AS ENUM (
    'reported', 'triaged', 'contained', 'resolved', 'closed', 'false_positive'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE incident_severity AS ENUM ('low', 'medium', 'high', 'critical');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE incident_event_type AS ENUM ('status_change', 'note', 'evidence', 'notification');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS isms.incidents (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference             varchar(40) NOT NULL,
  title                 varchar(200) NOT NULL,
  description           text NOT NULL,
  category              varchar(64) NOT NULL,
  severity              incident_severity NOT NULL,
  status                incident_status NOT NULL DEFAULT 'reported',

  -- When it was DETECTED, not when the row was created: every deadline counts
  -- from detection, and the two differ by however long the form took.
  detected_at           timestamptz NOT NULL,
  reported_by           uuid NOT NULL,
  assigned_to           uuid,

  contained_at          timestamptz,
  resolved_at           timestamptz,
  closed_at             timestamptz,

  root_cause            text,
  lessons_learned       text,

  asset_id              uuid REFERENCES assets.assets (id) ON DELETE SET NULL,
  -- SET NULL, not CASCADE: closing a risk must not erase the incident that proved
  -- it was real.
  risk_id               uuid REFERENCES isms.risks (id) ON DELETE SET NULL,

  personal_data_breach  boolean NOT NULL DEFAULT false,
  regulator_notified_at timestamptz,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  -- Invariant 1, written as `NOT in-those-states OR timestamp-present` — an
  -- implication rather than an equivalence, because the states are CUMULATIVE: a
  -- `closed` incident still carries the `contained_at` it passed through, so a
  -- later state REQUIRES the earlier timestamp rather than forbidding it.
  --
  -- Spelled out rather than using Postgres's `boolean <= boolean`, which is a
  -- legal way to write implication and an unreadable one.
  CONSTRAINT ck_incident_contained_pair CHECK (
    status NOT IN ('contained', 'resolved', 'closed') OR contained_at IS NOT NULL
  ),
  CONSTRAINT ck_incident_resolved_pair CHECK (
    status NOT IN ('resolved', 'closed') OR resolved_at IS NOT NULL
  ),
  CONSTRAINT ck_incident_closed_pair CHECK (
    (status = 'closed') = (closed_at IS NOT NULL)
  ),

  -- Invariant 2.
  CONSTRAINT ck_incident_timeline_order CHECK (
    (contained_at IS NULL OR contained_at >= detected_at)
    AND (resolved_at IS NULL OR contained_at IS NULL OR resolved_at >= contained_at)
    AND (resolved_at IS NULL OR resolved_at >= detected_at)
    AND (closed_at IS NULL OR resolved_at IS NULL OR closed_at >= resolved_at)
  ),

  -- Invariant 3.
  CONSTRAINT ck_incident_resolution_evidence CHECK (
    status NOT IN ('resolved', 'closed') OR length(btrim(coalesce(root_cause, ''))) >= 10
  ),
  CONSTRAINT ck_incident_closure_evidence CHECK (
    status <> 'closed' OR length(btrim(coalesce(lessons_learned, ''))) >= 10
  ),

  -- Invariant 4.
  CONSTRAINT ck_incident_false_positive CHECK (
    status <> 'false_positive'
    OR (contained_at IS NULL AND resolved_at IS NULL AND closed_at IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_incident_reference ON isms.incidents (reference);
-- The response queue: what is open, worst first.
CREATE INDEX IF NOT EXISTS ix_incident_status_severity ON isms.incidents (status, severity);
CREATE INDEX IF NOT EXISTS ix_incident_assignee ON isms.incidents (assigned_to);
CREATE INDEX IF NOT EXISTS ix_incident_risk ON isms.incidents (risk_id);
CREATE INDEX IF NOT EXISTS ix_incident_asset ON isms.incidents (asset_id);
-- The breach-deadline report. On `detected_at`, because the 72-hour deadline is
-- derived from it, and PARTIAL because only an unnotified breach can be overdue —
-- so the index stays small however many incidents accumulate.
CREATE INDEX IF NOT EXISTS ix_incident_breach_detected
  ON isms.incidents (detected_at)
  WHERE personal_data_breach = true AND regulator_notified_at IS NULL;

CREATE TABLE IF NOT EXISTS isms.incident_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id  uuid NOT NULL REFERENCES isms.incidents (id) ON DELETE CASCADE,
  type         incident_event_type NOT NULL,
  detail       text NOT NULL,
  -- Never null: an anonymous timeline entry is not evidence.
  recorded_by  uuid NOT NULL,
  -- When the described thing HAPPENED, which may precede when it was written: a
  -- responder reconstructing the night after needs "the alert fired at 02:14".
  occurred_at  timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- By when things happened, `id` last: `occurred_at` is emphatically not unique —
-- several entries share a minute during an incident — so without the tiebreaker
-- pagination over a long timeline drops and repeats rows.
CREATE INDEX IF NOT EXISTS ix_incident_event_incident
  ON isms.incident_events (incident_id, occurred_at, id);

-- ============================================================================
-- Grants for the least-privilege roles
-- ============================================================================
-- Granted explicitly rather than relying on the `isms` default privileges from
-- migration 0019: those apply only when the creating role matches, and a mismatch
-- surfaces as a 500 on the first insert in CI rather than anything legible.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON isms.incidents, isms.incident_events TO opshub_app, opshub_worker;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_migrate') THEN
      GRANT ALL ON isms.incidents, isms.incident_events TO opshub_migrate;
    END IF;
  END IF;
END $$;
