-- ============================================================================
-- Migration 0022: the information asset register, classification and its history
-- ============================================================================
-- THIS IS NOT `assets.assets`. That table is the DEVICE inventory — asset tag,
-- serial number, MDM device id, warranty, and a status that runs in_stock →
-- assigned → in_repair → retired → lost. An information asset is a payroll
-- system, a customer database, a room of signed contracts. Putting the second
-- kind in the first table would mean a fabricated `asset_tag` for "Customer CRM",
-- a permanently null `serial_number`, and a status column that lies: a database
-- is never `in_stock`.
--
-- The relationship between the two is real, though, and it is modelled where it
-- exists — `information_asset_devices`. That link answers the question security
-- asks the moment a laptop goes missing: WHAT WAS ON IT. It is a table and not a
-- column because one laptop holds several information assets and one system lives
-- on many laptops.
--
-- `isms.risks.asset_id` and `isms.incidents.asset_id` are untouched and still mean
-- a DEVICE. A lost-laptop incident reaches classification through the device link,
-- so neither table needed a second nullable pointer.
--
-- WHY `classification_levels` IS A TABLE AND NOT JUST THE ENUM
--
-- Two things have to be stated once: the RANK and the HANDLING RULES. Rank cannot
-- live in the enum's declaration order — Postgres does sort an enum that way, so
-- it would appear to work, and then break silently the first time somebody appends
-- a label and makes it the highest by accident. Handling rules cannot live on each
-- asset without being copy-pasted per row and drifting.
--
-- The table is keyed BY the enum, so a level and a label are the same thing rather
-- than two lists to reconcile, and `information_assets.classification` is an FK to
-- it: a classified asset always has a rank to sort by and rules to hand somebody.
-- The one gap a constraint cannot close — an enum value with no level row — is
-- covered by a test that reads the levels back and compares them with the enum.
--
-- INVARIANTS
--
-- 1. EVERY ASSET HAS AN OWNER — `owner_id NOT NULL`. The most-audited fact about
--    an asset register, so it is a thing that cannot happen rather than a report
--    to chase. The employee's existence is checked by the service: cross-schema
--    references here carry no FK, matching `soa_entries.owner_id`.
--
-- 2. THE LABEL AND THE CONFIDENTIALITY RATING CANNOT CONTRADICT EACH OTHER —
--    `ck_information_asset_classification_confidentiality`. `public` with a
--    confidentiality rating above the floor is a contradiction in terms, and
--    `restricted` at 1 or 2 means somebody labelled it without assessing it.
--
--    ONLY THE TWO EXTREMES ARE CONSTRAINED. The middle of the scale is a
--    judgement call, and forcing an exact label-to-rating mapping would make the
--    rating a restatement of the label rather than an independent assessment.
--
-- 3. PERSONAL DATA IS NEVER PUBLIC OR MERELY INTERNAL —
--    `ck_information_asset_personal_data_classification`. `isms.incidents` keys
--    its 72-hour breach clock off this column, so it has to mean something alone.
--
-- 4. RATINGS AND RETENTION ARE IN RANGE — `ck_information_asset_cia_range` uses
--    1..5, the same scale as the risk register's likelihood and impact, so a risk
--    about an asset and the asset itself are read on one scale.
--
-- 5. A CHANGE MUST CHANGE SOMETHING, AND SAY WHY —
--    `ck_asset_classification_history_change` and
--    `ck_asset_classification_history_reason`. A row from `confidential` to
--    `confidential` is noise in the one place that must stay readable, and a
--    one-word reason is the box-ticking the history exists to prevent.
--
-- Every CHECK here is also restated in `InformationAssetService` as a coded
-- refusal: a raw constraint violation reaches the caller as a 500 with no error
-- code, which is useless to the screen that has to explain it.
-- ============================================================================

CREATE TYPE information_classification AS ENUM (
  'public',
  'internal',
  'confidential',
  'restricted'
);

-- Deliberately NOT the same list as `asset_type`, which enumerates devices.
CREATE TYPE information_asset_type AS ENUM (
  'system',
  'application',
  'database',
  'dataset',
  'repository',
  'document_set',
  'physical_record',
  'service',
  'other'
);

CREATE TABLE IF NOT EXISTS isms.classification_levels (
  code                information_classification PRIMARY KEY,
  -- Higher is more protected. THE authoritative ordering.
  rank                smallint NOT NULL,
  label               varchar(60) NOT NULL,
  handling_rules      text NOT NULL,
  encryption_required boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- Ranks are a total order: two levels sharing one cannot be compared, and
  -- "is this a reduction in protection?" is exactly a comparison of ranks.
  CONSTRAINT uq_classification_level_rank UNIQUE (rank),
  CONSTRAINT ck_classification_level_rank CHECK (rank > 0)
);

--> statement-breakpoint

-- Seeded here rather than by the application seed: `information_assets.classification`
-- is an FK to this table, so an empty levels table makes the register unusable —
-- that is reference data the schema depends on, not fixtures.
INSERT INTO isms.classification_levels (code, rank, label, handling_rules, encryption_required)
VALUES
  ('public', 1, 'Public',
   'Approved for release outside the organisation. No handling restrictions. Publication still '
   || 'requires the owner''s approval — "public" describes who may read it, not who may publish it.',
   false),
  ('internal', 2, 'Internal',
   'For employees and contractors. May be shared inside the organisation without further approval. '
   || 'Not to be posted externally, and not to be sent to a personal mailbox.',
   false),
  ('confidential', 3, 'Confidential',
   'Restricted to those with a business need. Encrypt at rest and in transit. Sharing outside the '
   || 'organisation needs the owner''s approval and an agreement in place. Dispose of by secure '
   || 'deletion or shredding.',
   true),
  ('restricted', 4, 'Restricted',
   'The highest level: access is named individuals, not teams. Encrypt at rest and in transit, log '
   || 'access, and review the access list at least quarterly. Never copied to unmanaged devices or '
   || 'removable media. Loss or suspected exposure is reported as a security incident immediately.',
   true)
ON CONFLICT (code) DO NOTHING;

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS isms.information_assets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Quoted in the register, in risk assessments and in audit findings, e.g. `IA-014`.
  reference        varchar(40) NOT NULL,
  name             varchar(200) NOT NULL,
  description      text,
  type             information_asset_type NOT NULL,

  -- RESTRICT: a level in use cannot be removed from underneath the assets carrying it.
  classification   information_classification NOT NULL
                     REFERENCES isms.classification_levels (code) ON DELETE RESTRICT,

  -- No FK: `identity.employees` is a separate schema and every other cross-schema
  -- reference in this codebase is by id alone, so the service checks it.
  owner_id         uuid NOT NULL,
  -- Optional: plenty of assets have no separate custodian, and inventing one would
  -- make the column a formality rather than the person a responder actually calls.
  custodian_id     uuid,

  confidentiality  smallint NOT NULL,
  integrity        smallint NOT NULL,
  availability     smallint NOT NULL,

  personal_data    boolean NOT NULL DEFAULT false,

  location         varchar(200),
  retention_months integer,

  last_reviewed_at timestamptz,
  -- "Overdue" is this against today, never a stored flag.
  review_due_on    date,
  -- Retired assets stay, for the same reason retired controls do: a risk assessment
  -- and an incident from last year reference this row.
  retired_at       timestamptz,

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  -- The 1..5 bounds are mirrored in `libs/modules/isms/src/domain/rating.ts`, which is the
  -- single source for the application layer. SQL cannot import it, so this is the one
  -- remaining copy — changing the scale means changing both, plus
  -- `ACCEPTANCE_APPROVAL_THRESHOLD`, which is expressed in scale units.
  CONSTRAINT ck_information_asset_cia_range CHECK (
    confidentiality BETWEEN 1 AND 5
    AND integrity BETWEEN 1 AND 5
    AND availability BETWEEN 1 AND 5
  ),
  -- Only the extremes. See invariant 2 above for why the middle is left free.
  CONSTRAINT ck_information_asset_classification_confidentiality CHECK (
    (classification <> 'public' OR confidentiality = 1)
    AND (classification <> 'restricted' OR confidentiality >= 4)
  ),
  CONSTRAINT ck_information_asset_personal_data_classification CHECK (
    personal_data = false OR classification IN ('confidential', 'restricted')
  ),
  CONSTRAINT ck_information_asset_retention_positive CHECK (
    retention_months IS NULL OR retention_months > 0
  ),
  -- A register whose entries are named "x" cannot be handed to an auditor.
  CONSTRAINT ck_information_asset_name_substance CHECK (length(btrim(name)) >= 3)
);

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS uq_information_asset_reference
  ON isms.information_assets (reference);
CREATE INDEX IF NOT EXISTS ix_information_asset_classification
  ON isms.information_assets (classification);
CREATE INDEX IF NOT EXISTS ix_information_asset_owner
  ON isms.information_assets (owner_id);
CREATE INDEX IF NOT EXISTS ix_information_asset_type
  ON isms.information_assets (type);
-- The review-due report's query, matching `ix_soa_review_due`.
CREATE INDEX IF NOT EXISTS ix_information_asset_review_due
  ON isms.information_assets (review_due_on);

--> statement-breakpoint

-- APPEND-ONLY. No update, no delete — the register's label is read by people
-- deciding how to handle information, and a history that can be edited afterwards
-- cannot show that protection was once higher, which is the change worth seeing.
CREATE TABLE IF NOT EXISTS isms.asset_classification_history (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  information_asset_id  uuid NOT NULL
                          REFERENCES isms.information_assets (id) ON DELETE CASCADE,
  -- Null ONLY for the initial classification recorded when the asset was registered.
  -- That first row is what makes the chain complete: the current label traces back
  -- to a decision rather than appearing from an unexplained default.
  from_level            information_classification,
  to_level              information_classification NOT NULL,
  reason                text NOT NULL,
  changed_by            uuid NOT NULL,
  changed_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_asset_classification_history_change CHECK (
    from_level IS NULL OR from_level <> to_level
  ),
  CONSTRAINT ck_asset_classification_history_reason CHECK (length(btrim(reason)) >= 10)
);

--> statement-breakpoint

-- By when it changed, `id` last: a bulk reclassification gives several rows the
-- same timestamp, so without the tiebreaker pagination drops and repeats rows.
CREATE INDEX IF NOT EXISTS ix_asset_classification_history_asset
  ON isms.asset_classification_history (information_asset_id, changed_at, id);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS isms.information_asset_devices (
  information_asset_id uuid NOT NULL
                         REFERENCES isms.information_assets (id) ON DELETE CASCADE,
  -- RESTRICT, not CASCADE or SET NULL. A hard delete of a device still holding
  -- registered information fails, because losing the link loses the answer to
  -- "what was on it". A backstop rather than a workflow: the API never deletes a
  -- device, it RETIRES one, and retirement leaves the link intact on purpose.
  device_asset_id      uuid NOT NULL
                         REFERENCES assets.assets (id) ON DELETE RESTRICT,
  linked_by            uuid NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),

  -- Natural key: the same device linked twice to one asset is still one link.
  CONSTRAINT pk_information_asset_device PRIMARY KEY (information_asset_id, device_asset_id)
);

--> statement-breakpoint

-- "What is on this device?" — the direction a lost laptop is read from.
CREATE INDEX IF NOT EXISTS ix_information_asset_device_device
  ON isms.information_asset_devices (device_asset_id);

--> statement-breakpoint

-- ============================================================================
-- Grants for the least-privilege roles
-- ============================================================================
-- Granted explicitly rather than relying on the `isms` default privileges from
-- migration 0019: those apply only when the creating role matches, and a mismatch
-- surfaces as a 500 on the first insert in CI rather than anything legible.
--
-- THE NARROWING IS DONE WITH `REVOKE`, NOT A SMALLER `GRANT`. Migration 0019 ran
--
--   ALTER DEFAULT PRIVILEGES IN SCHEMA isms
--     GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO opshub_app, opshub_worker;
--
-- so every table created in this schema arrives already holding all four. Writing
-- a narrower GRANT here would have been a no-op that READ like a restriction — the
-- privileges were granted at CREATE TABLE, before this block runs. The revoke is
-- what actually removes them.
--
--   * `classification_levels` is reference data seeded above, so the application
--     keeps SELECT only. The levels and their handling rules change by migration,
--     in review — not by whoever happens to hold `information_asset.manage`.
--
--   * `asset_classification_history` is APPEND-ONLY, so it keeps SELECT and INSERT.
--     Documenting "there is deliberately no update" in the repository port
--     describes the code that exists today; withholding the privilege is what makes
--     it true of the code somebody writes next year.
--
-- The same correction is applied to `isms.incident_events` from migration 0021.
-- That table is append-only by the same argument and has only ever been INSERTed
-- into and SELECTed from, but it was left holding UPDATE and DELETE — its
-- append-only property was declared and not enforced. Leaving the two siblings
-- inconsistent would be worse than either choice made consistently.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON isms.information_assets, isms.information_asset_devices
      TO opshub_app, opshub_worker;

    REVOKE INSERT, UPDATE, DELETE ON isms.classification_levels
      FROM opshub_app, opshub_worker;
    REVOKE UPDATE, DELETE ON isms.asset_classification_history
      FROM opshub_app, opshub_worker;
    REVOKE UPDATE, DELETE ON isms.incident_events
      FROM opshub_app, opshub_worker;
    -- SELECT is not implied by the revokes above; state it so a future reordering
    -- of this block cannot leave the levels unreadable.
    GRANT SELECT ON isms.classification_levels TO opshub_app, opshub_worker;
    GRANT SELECT, INSERT ON isms.asset_classification_history TO opshub_app, opshub_worker;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_migrate') THEN
      GRANT ALL ON isms.classification_levels,
                   isms.information_assets,
                   isms.asset_classification_history,
                   isms.information_asset_devices
        TO opshub_migrate;
    END IF;
  END IF;
END $$;
