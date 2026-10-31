-- ============================================================================
-- Migration 0018: training records, and the attachment plumbing they need
-- ============================================================================
-- TWO THINGS, and they are one change: training certificates are the first
-- upload surface that ACCUMULATES, so the storage layer has to grow a link table
-- before the domain that needs it can exist.
--
-- PART 1 — storage
--
--   * `stored_files.checksum_sha256` — the client's base64 SHA-256, recorded at
--     presign and compared on confirm. Size alone cannot catch a same-length
--     substitution. Nullable: nothing enforces a checksum at PUT time and the
--     four surfaces that predate this column never declared one.
--
--   * `storage.attachments` — the link between an owning entity and its files.
--     `stored_files.linked_entity_type/id` already existed but is single-valued
--     cleanup bookkeeping, not ownership: one file, one entity, forever. That was
--     enough while every surface was 1:1 and kept its key on the domain row
--     (`employees.photo_storage_key` and friends), which is why those surfaces are
--     deliberately NOT migrated here — their key column IS the relationship.
--     Polymorphic on (entity_type, entity_id) following rova's `work.attachments`;
--     `entity_id` carries no FK because it cannot point at two tables, and that is
--     the standing cost of the shape. `file_id` cascades.
--
-- PART 2 — training
--
-- "Mai did fire safety in March" is a fact about a person. The questions actually
-- asked are about the ORG: which courses must a QA Engineer hold, who is missing
-- one, whose certificate lapses this quarter. The requirement lives on the
-- POSITION, not the person — the ISO 9001 / 27001 competency framing — so three
-- tables: the catalogue, what each position requires, and who completed what.
--
--   * ONE CURRENT RECORD per (employee, course) — `uq_training_record_current`,
--     partial over rows that are neither superseded nor revoked. Retraining must
--     accumulate; two rows both claiming to be the live answer must not.
--
--   * `records.expires_on` is FROZEN at completion from `courses.validity_months`.
--     Recomputing on read would restate history every time somebody edited the
--     course, which is the same reason a leave request freezes its day count.
--
--   * NO expiry sweep, deliberately. Unlike a contract, a lapsed certificate
--     changes nothing about what may happen next — it is a report, and
--     `expires_on < today` answers it without a job that can fall behind. The
--     `revoked`/`superseded` states are decisions somebody made, and those ARE
--     stored.
-- ============================================================================

-- ── Part 1: storage ─────────────────────────────────────────────────────────

ALTER TABLE storage.stored_files
  ADD COLUMN IF NOT EXISTS checksum_sha256 varchar(64);

CREATE TABLE IF NOT EXISTS storage.attachments (
  entity_type  varchar(64) NOT NULL,
  entity_id    uuid NOT NULL,
  file_id      uuid NOT NULL REFERENCES storage.stored_files (id) ON DELETE CASCADE,
  attached_by  uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- The same file attached twice to one entity is still one attachment.
  CONSTRAINT attachments_pkey PRIMARY KEY (entity_type, entity_id, file_id)
);

CREATE INDEX IF NOT EXISTS ix_attachment_entity
  ON storage.attachments (entity_type, entity_id);
-- Drives the reaper's "is this file still referenced?" question.
CREATE INDEX IF NOT EXISTS ix_attachment_file
  ON storage.attachments (file_id);

-- ── Part 2: training ────────────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS training;

DO $$ BEGIN
  CREATE TYPE training_record_status AS ENUM ('valid', 'expired', 'revoked');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE training_requirement_kind AS ENUM ('mandatory', 'recommended');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS training.courses (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code             varchar(32) NOT NULL,
  title            varchar(200) NOT NULL,
  category         varchar(64) NOT NULL,
  provider         varchar(160),
  description      text,
  -- Months, not days: certifications are stated in months and adding months to a
  -- date is exact where 730 days drifts across leap years. NULL = never lapses.
  validity_months  integer,
  retired_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_training_validity_positive
    CHECK (validity_months IS NULL OR validity_months > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_training_course_code ON training.courses (code);
CREATE INDEX IF NOT EXISTS ix_training_course_category ON training.courses (category);

CREATE TABLE IF NOT EXISTS training.position_requirements (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  position_id  uuid NOT NULL REFERENCES positions.positions (id) ON DELETE CASCADE,
  course_id    uuid NOT NULL REFERENCES training.courses (id) ON DELETE RESTRICT,
  kind         training_requirement_kind NOT NULL DEFAULT 'mandatory',
  -- NULL means "before starting". A grace period is what makes the gap report
  -- usable: without one every new hire is non-compliant on day one.
  grace_days   integer,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_training_grace_non_negative CHECK (grace_days IS NULL OR grace_days >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_training_requirement
  ON training.position_requirements (position_id, course_id);
CREATE INDEX IF NOT EXISTS ix_training_requirement_position
  ON training.position_requirements (position_id);
CREATE INDEX IF NOT EXISTS ix_training_requirement_course
  ON training.position_requirements (course_id);

CREATE TABLE IF NOT EXISTS training.records (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id       uuid NOT NULL,
  course_id         uuid NOT NULL REFERENCES training.courses (id) ON DELETE RESTRICT,
  completed_on      date NOT NULL,
  expires_on        date,
  result            varchar(64),
  score             numeric(5, 2),
  status            training_record_status NOT NULL DEFAULT 'valid',
  verified_by       uuid,
  verified_at       timestamptz,
  superseded_by_id  uuid,
  revoked_reason    varchar(200),
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- A certificate that expired before it was earned is a data-entry error.
  CONSTRAINT ck_training_record_window
    CHECK (expires_on IS NULL OR expires_on >= completed_on),
  CONSTRAINT ck_training_score_range
    CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
  -- A revocation nobody can account for later is worse than none.
  CONSTRAINT ck_training_revoked_reason
    CHECK ((status = 'revoked') = (revoked_reason IS NOT NULL)),
  CONSTRAINT ck_training_not_self_superseded
    CHECK (superseded_by_id IS NULL OR superseded_by_id <> id),
  -- Verification is one act: both columns or neither.
  CONSTRAINT ck_training_verified_pair
    CHECK ((verified_by IS NULL) = (verified_at IS NULL))
);

-- One current record per (employee, course).
CREATE UNIQUE INDEX IF NOT EXISTS uq_training_record_current
  ON training.records (employee_id, course_id)
  WHERE superseded_by_id IS NULL AND status <> 'revoked';

CREATE INDEX IF NOT EXISTS ix_training_record_employee
  ON training.records (employee_id, completed_on);
CREATE INDEX IF NOT EXISTS ix_training_record_course
  ON training.records (course_id);
-- The expiry report's query.
CREATE INDEX IF NOT EXISTS ix_training_record_expiry
  ON training.records (status, expires_on);

-- ============================================================================
-- Grants for the least-privilege roles
-- ============================================================================
-- Migration 0012 granted `opshub_app` / `opshub_worker` access by iterating the
-- schemas that existed THEN, so every schema added later needs this block. Local
-- development cannot catch the omission — a developer connects as the owner, which
-- is exempt — but CI runs its e2e suite as `opshub_app` and fails with a 500 on the
-- first insert, which is how migration 0015 found out.
--
-- `storage.attachments` is a NEW TABLE IN AN EXISTING SCHEMA, so the default
-- privileges 0012 set would cover it only if the creating role matches. Granted
-- explicitly rather than relying on that.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON storage.attachments TO opshub_app, opshub_worker;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_migrate') THEN
      GRANT ALL ON storage.attachments TO opshub_migrate;
    END IF;

    GRANT USAGE ON SCHEMA training TO opshub_app, opshub_worker;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_migrate') THEN
      GRANT USAGE ON SCHEMA training TO opshub_migrate;
    END IF;

    GRANT SELECT, INSERT, UPDATE, DELETE
      ON ALL TABLES IN SCHEMA training TO opshub_app, opshub_worker;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA training TO opshub_app, opshub_worker;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_migrate') THEN
      GRANT ALL ON SCHEMA training TO opshub_migrate;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_migrate') THEN
      GRANT ALL ON ALL TABLES IN SCHEMA training TO opshub_migrate;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_migrate') THEN
      GRANT ALL ON ALL SEQUENCES IN SCHEMA training TO opshub_migrate;
    END IF;

    ALTER DEFAULT PRIVILEGES IN SCHEMA training
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO opshub_app, opshub_worker;
    ALTER DEFAULT PRIVILEGES IN SCHEMA training
      GRANT USAGE, SELECT ON SEQUENCES TO opshub_app, opshub_worker;
  END IF;
END $$;
