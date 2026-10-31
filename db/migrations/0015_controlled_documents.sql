-- ============================================================================
-- Migration 0015: controlled documents
-- ============================================================================
-- One primitive for ISMS policies, QMS procedures, work instructions, HR
-- handbooks and contract templates. They differ in who approves them and what
-- they say, not in their lifecycle: drafted, approved, published, acknowledged,
-- reviewed, superseded. Three schemas would make "which employees have not
-- acknowledged the current version of anything?" unanswerable in one query.
--
-- TWO INVARIANTS ARE ENFORCED HERE RATHER THAN IN THE SERVICE
--
-- 1. AT MOST ONE PUBLISHED VERSION PER DOCUMENT.
--    `uq_document_published_version` is a PARTIAL unique index on
--    (document_id) WHERE published_at IS NOT NULL AND superseded_at IS NULL.
--    Two concurrent publishes would otherwise both read "nothing published
--    yet", both write, and leave two versions in force — and the second reader
--    could not tell which one the organisation was actually following. A
--    service-level check cannot close that window; a unique index can.
--
-- 2. ACKNOWLEDGEMENT IS PER VERSION, AND IDEMPOTENT.
--    `uq_document_ack` on (version_id, employee_id). Acknowledging v1 says
--    nothing about v2, so a material revision requires fresh consent. Keying
--    this on document_id would carry old consent forward and overstate
--    compliance — the single most common way this feature is built wrong.
--
-- Deletion is not modelled. `documents.retired_at` retires; versions are never
-- removed, because "which revision was in force on this date" must stay
-- answerable years later.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS documents;

DO $$ BEGIN
  CREATE TYPE document_category AS ENUM (
    'isms_policy',
    'qms_procedure',
    'work_instruction',
    'hr_handbook',
    'contract_template'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE document_version_status AS ENUM (
    'draft',
    'in_review',
    'approved',
    'published',
    'superseded',
    'rejected'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS documents.documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        varchar(32) NOT NULL,
  title       varchar(240) NOT NULL,
  category    document_category NOT NULL,
  owner_id    uuid NOT NULL,
  retired_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_document_code ON documents.documents (code);
CREATE INDEX IF NOT EXISTS ix_document_category ON documents.documents (category);
CREATE INDEX IF NOT EXISTS ix_document_owner ON documents.documents (owner_id);

CREATE TABLE IF NOT EXISTS documents.document_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id     uuid NOT NULL REFERENCES documents.documents (id) ON DELETE CASCADE,
  version         integer NOT NULL,
  body            text,
  storage_key     varchar(512),
  change_summary  text,
  status          document_version_status NOT NULL DEFAULT 'draft',
  request_id      uuid,
  approved_by     uuid,
  approved_at     timestamptz,
  published_at    timestamptz,
  review_due_on   date,
  superseded_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_document_version
  ON documents.document_versions (document_id, version);

-- Invariant 1. Partial, so drafts and superseded rows are unconstrained while at most one
-- version per document can be in force at any instant.
CREATE UNIQUE INDEX IF NOT EXISTS uq_document_published_version
  ON documents.document_versions (document_id)
  WHERE published_at IS NOT NULL AND superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS ix_document_version_document
  ON documents.document_versions (document_id, version);
CREATE INDEX IF NOT EXISTS ix_document_version_status
  ON documents.document_versions (status);
CREATE INDEX IF NOT EXISTS ix_document_version_review_due
  ON documents.document_versions (review_due_on);

CREATE TABLE IF NOT EXISTS documents.document_acknowledgements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id       uuid NOT NULL REFERENCES documents.document_versions (id) ON DELETE CASCADE,
  employee_id      uuid NOT NULL,
  acknowledged_at  timestamptz NOT NULL DEFAULT now()
);

-- Invariant 2.
CREATE UNIQUE INDEX IF NOT EXISTS uq_document_ack
  ON documents.document_acknowledgements (version_id, employee_id);
CREATE INDEX IF NOT EXISTS ix_document_ack_employee
  ON documents.document_acknowledgements (employee_id);

-- ============================================================================
-- Grants for the least-privilege roles
-- ============================================================================
-- Migration 0012 created `opshub_app` / `opshub_worker` and granted them access to
-- the schemas that existed THEN, by iterating a fixed array. A schema added later
-- is invisible to it, so without this block the runtime role can see `documents`
-- but not read or write anything in it.
--
-- This is not theoretical and it is not caught by local development: a developer
-- connects as the owner, which is exempt, so everything works. CI runs its e2e
-- suite as `opshub_app` deliberately for exactly this reason, and it failed here
-- with a 500 on the first insert — which is the cheap version of the same failure
-- happening after the production cutover, on a code path with no obvious
-- connection to a migration.
--
-- ANY MIGRATION THAT ADDS A SCHEMA MUST REPEAT THIS. There is no way to make 0012
-- retroactive, and `ALTER DEFAULT PRIVILEGES` only covers FUTURE objects in a
-- schema that is already listed.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_app') THEN
    GRANT USAGE ON SCHEMA documents TO opshub_app, opshub_worker;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_migrate') THEN
      GRANT USAGE ON SCHEMA documents TO opshub_migrate;
    END IF;

    GRANT SELECT, INSERT, UPDATE, DELETE
      ON ALL TABLES IN SCHEMA documents TO opshub_app, opshub_worker;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA documents TO opshub_app, opshub_worker;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_migrate') THEN
      GRANT ALL ON SCHEMA documents TO opshub_migrate;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_migrate') THEN
      GRANT ALL ON ALL TABLES IN SCHEMA documents TO opshub_migrate;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_migrate') THEN
      GRANT ALL ON ALL SEQUENCES IN SCHEMA documents TO opshub_migrate;
    END IF;

    -- Future tables in this schema, so the next migration that adds one here does not
    -- reintroduce the same failure. Per GRANTOR, and the grantor is whoever runs migrations.
    ALTER DEFAULT PRIVILEGES IN SCHEMA documents
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO opshub_app, opshub_worker;
    ALTER DEFAULT PRIVILEGES IN SCHEMA documents
      GRANT USAGE, SELECT ON SEQUENCES TO opshub_app, opshub_worker;
  END IF;
END $$;
