-- ============================================================================
-- Migration 0023: the supplier register, due diligence, and the risks vendors carry
-- ============================================================================
-- ISO 27001 A.5.19–A.5.23 (supplier relationships) and GDPR Article 28
-- (processors). The questions, in the order an auditor asks them: who do we depend
-- on, what did we check before we depended on them, and when did we last look
-- again.
--
-- WHAT ALREADY HELD VENDOR-SHAPED TEXT, AND WHY IT IS NOT THIS
--
-- `licenses.software_licenses.vendor` (NOT NULL varchar) and
-- `compliance.software_catalog.publisher`. Neither is a vendor: they are labels on
-- a licence and on a piece of software, and "Microsoft" in eleven licence rows is
-- eleven strings rather than one supplier with one owner and one assessment
-- history.
--
-- `software_licenses.vendor_id` is added ALONGSIDE the text, not replacing it —
-- the same move `positions` made with `employees.job_title`. The text stays
-- because existing screens read it and not every line item deserves a
-- due-diligence file; the reference is what turns "what do we buy from this
-- supplier, and did anyone assess them" into a join. No backfill: matching
-- free-text names to register rows is a judgement, and guessing it in a migration
-- would silently attach spend to the wrong supplier. The anti-join report is what
-- makes the un-linked rows visible instead of forgotten.
--
-- WHY `vendor_criticality_levels` IS A TABLE
--
-- The same two reasons `isms.classification_levels` is one. The RANK cannot live
-- in the enum's declaration order — Postgres does sort an enum that way, so it
-- appears to work until somebody appends a tier and silently makes it the highest.
-- And `review_interval_months` must be stated once: the next review date is
-- computed from it when an assessment is recorded, so the cadence is policy in one
-- place rather than a number typed in per vendor by whoever fills the form.
--
-- INVARIANTS
--
-- 1. EVERY VENDOR HAS AN OWNER — `owner_id NOT NULL`, on the same reasoning as
--    `information_assets.owner_id`.
--
-- 2. AN ACTIVE PROCESSOR HAS A WRITTEN AGREEMENT —
--    `ck_vendor_processor_agreement`. GDPR Article 28(3) requires processing to be
--    governed by a contract, so a supplier handling personal data on our behalf
--    cannot be `active` without one recorded.
--
--    DELIBERATELY SCOPED TO `active`. Registering a prospective processor before
--    the agreement is signed is the normal order of events; a blanket requirement
--    would push that record-keeping outside the system, which is worse than
--    recording it early.
--
-- 3. TERMINATION IS PAIRED WITH ITS DATE AND ITS REASON —
--    `ck_vendor_terminated_pair`, the same status/timestamp pairing the incident
--    module uses. A `terminated` row with no date cannot be reported on; a date on
--    a live supplier is a lie.
--
-- 4. THE CONTRACT WINDOW RUNS FORWARD — `ck_vendor_contract_window`, fronted by
--    the shared `assertDateOrder` guard so the caller gets a code, not a 500.
--
-- 5. CONDITIONS ARE REQUIRED WHEN AN ASSESSMENT IMPOSES THEM —
--    `ck_vendor_assessment_conditions`. `pass_with_conditions` with nothing
--    written down is the outcome people pick to avoid saying no, and it is
--    worthless a year later.
--
-- Every CHECK is restated in `VendorService` as a coded refusal: a raw constraint
-- violation reaches the caller as a 500 with no error code.
--
-- WHAT THE SERVICE HOLDS THAT NO CHECK CAN. Going `active` is the act that creates
-- exposure, so it requires a CURRENT PASSING ASSESSMENT — a rule about another
-- table's latest row, which is a query rather than a constraint. It also needs the
-- `vendor.approve` permission, kept out of every role bundle exactly as
-- `risk.accept` and `information_asset.declassify` are.
-- ============================================================================

CREATE TYPE vendor_criticality AS ENUM ('low', 'medium', 'high', 'critical');

CREATE TYPE vendor_status AS ENUM ('prospective', 'active', 'suspended', 'terminated');

CREATE TYPE vendor_assessment_outcome AS ENUM ('pass', 'pass_with_conditions', 'fail');

CREATE TABLE IF NOT EXISTS isms.vendor_criticality_levels (
  code                          vendor_criticality PRIMARY KEY,
  -- Higher matters more. THE authoritative ordering.
  rank                          smallint NOT NULL,
  label                         varchar(60) NOT NULL,
  description                   text NOT NULL,
  -- Drives `vendors.review_due_on`, computed when an assessment is recorded.
  review_interval_months        integer NOT NULL,
  requires_independent_evidence boolean NOT NULL DEFAULT false,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  -- Ranks are a total order: two tiers sharing one cannot be compared.
  CONSTRAINT uq_vendor_criticality_rank UNIQUE (rank),
  CONSTRAINT ck_vendor_criticality_rank CHECK (rank > 0),
  -- A zero-month interval would make every assessment instantly overdue; a
  -- negative one would put the next review in the past.
  CONSTRAINT ck_vendor_criticality_interval CHECK (review_interval_months > 0)
);

--> statement-breakpoint

-- Seeded here rather than by the application seed: `vendors.criticality` is an FK
-- to this table, so an empty table makes the register unusable. That is reference
-- data the schema depends on, not fixtures.
--
-- The intervals are a starting policy, not a standard — ISO 27001 requires review
-- at planned intervals and leaves the interval to the organisation. They are in one
-- place so changing them is one UPDATE in one migration.
INSERT INTO isms.vendor_criticality_levels
  (code, rank, label, description, review_interval_months, requires_independent_evidence)
VALUES
  ('low', 1, 'Low',
   'No access to our data or systems, and readily replaceable. A stationery supplier. '
   || 'Losing them is an inconvenience.',
   36, false),
  ('medium', 2, 'Medium',
   'Limited access, or replaceable with modest disruption. Losing them costs a project a few '
   || 'weeks, not the business.',
   24, false),
  ('high', 3, 'High',
   'Access to internal or confidential information, or a service whose loss stops a team '
   || 'working. Replacement is a project.',
   12, true),
  ('critical', 4, 'Critical',
   'Holds restricted information or personal data, or runs a service the organisation cannot '
   || 'operate without. Replacement is measured in quarters, and an outage is an incident.',
   6, true)
ON CONFLICT (code) DO NOTHING;

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS isms.vendors (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Quoted in the register, in assessments and in audit findings, e.g. `VEN-014`.
  reference                     varchar(40) NOT NULL,
  name                          varchar(200) NOT NULL,
  -- The name on the contract, when it differs — which it usually does.
  legal_name                    varchar(200),
  -- What they actually do for us: the sentence that makes the tier defensible.
  services                      text NOT NULL,

  -- RESTRICT: a tier in use cannot be removed from underneath the vendors on it.
  criticality                   vendor_criticality NOT NULL
                                  REFERENCES isms.vendor_criticality_levels (code)
                                  ON DELETE RESTRICT,
  status                        vendor_status NOT NULL DEFAULT 'prospective',

  -- No FK: `identity.employees` is a separate schema and every other cross-schema
  -- reference in this codebase is by id alone, so the service checks it.
  owner_id                      uuid NOT NULL,

  data_processor                boolean NOT NULL DEFAULT false,
  -- The DPA as a controlled document. No FK, same cross-schema convention.
  data_processing_agreement_id  uuid,
  data_location                 varchar(200),

  contract_starts_on            date,
  contract_ends_on              date,
  notice_period_days            integer,

  -- Written by the service from the tier's interval when an assessment is recorded,
  -- never accepted from a caller — the same rule that keeps risk scores generated.
  review_due_on                 date,

  terminated_at                 timestamptz,
  termination_reason            text,

  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),

  -- Invariant 2. An implication, so the other three states are unaffected.
  CONSTRAINT ck_vendor_processor_agreement CHECK (
    NOT (status = 'active' AND data_processor)
    OR data_processing_agreement_id IS NOT NULL
  ),
  -- Invariant 3. An equivalence, unlike the incident timestamps: vendor status is
  -- not cumulative, so a live supplier must NOT carry a termination date.
  CONSTRAINT ck_vendor_terminated_pair CHECK (
    (status = 'terminated') = (terminated_at IS NOT NULL)
  ),
  -- `coalesce(x, '')` is NOT decoration. `length(btrim(NULL)) >= 10` evaluates to
  -- NULL, and Postgres ACCEPTS a CHECK that returns NULL — so the obvious spelling
  -- of this constraint passes precisely the row it exists to reject, the one where
  -- the column was left out entirely. Migration 0021 uses the same idiom for the
  -- incident evidence CHECKs; all three here were written the naive way first and
  -- caught by probing the real table.
  CONSTRAINT ck_vendor_termination_reason CHECK (
    terminated_at IS NULL OR length(btrim(coalesce(termination_reason, ''))) >= 10
  ),
  -- Invariant 4. Inclusive, matching the shared `assertDateOrder` guard.
  CONSTRAINT ck_vendor_contract_window CHECK (
    contract_starts_on IS NULL
    OR contract_ends_on IS NULL
    OR contract_ends_on >= contract_starts_on
  ),
  CONSTRAINT ck_vendor_notice_period CHECK (
    notice_period_days IS NULL OR notice_period_days >= 0
  ),
  -- A register whose entries are named "x" cannot be handed to an auditor.
  CONSTRAINT ck_vendor_name_substance CHECK (length(btrim(name)) >= 2),
  CONSTRAINT ck_vendor_services_substance CHECK (length(btrim(services)) >= 10)
);

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_reference ON isms.vendors (reference);
CREATE INDEX IF NOT EXISTS ix_vendor_status_criticality
  ON isms.vendors (status, criticality);
CREATE INDEX IF NOT EXISTS ix_vendor_owner ON isms.vendors (owner_id);
-- The review-due report's query, matching `ix_soa_review_due`.
CREATE INDEX IF NOT EXISTS ix_vendor_review_due ON isms.vendors (review_due_on);
-- "Which suppliers process personal data?" — the Article 30 question.
CREATE INDEX IF NOT EXISTS ix_vendor_processor ON isms.vendors (data_processor);

--> statement-breakpoint

-- One assessment per row, never updated in place. Last year's result is the
-- evidence that last year's decision was reasonable; overwriting it leaves that
-- decision unexplained. Corrections are new assessments — which is also how a
-- supplier who fixed their conditions is recorded as having done so.
CREATE TABLE IF NOT EXISTS isms.vendor_assessments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id            uuid NOT NULL REFERENCES isms.vendors (id) ON DELETE CASCADE,
  assessed_at          timestamptz NOT NULL DEFAULT now(),
  assessed_by          uuid NOT NULL,
  outcome              vendor_assessment_outcome NOT NULL,
  -- What was actually examined: the questionnaire, the SOC 2 report, the site visit.
  scope                text NOT NULL,
  findings             text,
  conditions           text,
  evidence_document_id uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),

  -- Invariant 5.
  -- `coalesce` for the NULL-CHECK reason given on `ck_vendor_termination_reason`:
  -- without it, an assessment with conditions omitted is exactly what gets through.
  CONSTRAINT ck_vendor_assessment_conditions CHECK (
    outcome <> 'pass_with_conditions' OR length(btrim(coalesce(conditions, ''))) >= 10
  ),
  -- An assessment with no stated scope cannot be relied on, or repeated.
  CONSTRAINT ck_vendor_assessment_scope CHECK (length(btrim(scope)) >= 10),
  -- A failed assessment has to say what failed, or it cannot be acted on.
  CONSTRAINT ck_vendor_assessment_failure_findings CHECK (
    outcome <> 'fail' OR length(btrim(coalesce(findings, ''))) >= 10
  )
);

--> statement-breakpoint

-- Latest-first reads, `id` last: a bulk import gives several assessments the same
-- timestamp, so without the tiebreaker paging a long history drops and repeats rows.
CREATE INDEX IF NOT EXISTS ix_vendor_assessment_vendor
  ON isms.vendor_assessments (vendor_id, assessed_at, id);

--> statement-breakpoint

-- Which register risks a supplier carries. Modelled exactly like `isms.risk_controls`,
-- with the same anti-join payoff: a critical supplier with no risk recorded against
-- them is a gap in the assessment, surfaced rather than assumed away.
CREATE TABLE IF NOT EXISTS isms.vendor_risks (
  vendor_id  uuid NOT NULL REFERENCES isms.vendors (id) ON DELETE CASCADE,
  risk_id    uuid NOT NULL REFERENCES isms.risks (id) ON DELETE CASCADE,
  linked_by  uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  -- Natural key: the same risk linked twice to one vendor is still one link.
  CONSTRAINT pk_vendor_risk PRIMARY KEY (vendor_id, risk_id)
);

--> statement-breakpoint

-- "Which suppliers does this risk involve?" — the direction a risk review reads from.
CREATE INDEX IF NOT EXISTS ix_vendor_risk_risk ON isms.vendor_risks (risk_id);

--> statement-breakpoint

-- ============================================================================
-- The licence → vendor reference
-- ============================================================================
-- Nullable and NOT backfilled. Matching free-text vendor names to register rows is
-- a judgement call, and guessing it here would silently attach spend to the wrong
-- supplier. `SET NULL` because removing a vendor from the register must never
-- delete a licence.
ALTER TABLE licenses.software_licenses
  ADD COLUMN IF NOT EXISTS vendor_id uuid
    REFERENCES isms.vendors (id) ON DELETE SET NULL;

--> statement-breakpoint

-- The vendor-spend join, and the anti-join that finds unassessed suppliers.
CREATE INDEX IF NOT EXISTS ix_sl_vendor ON licenses.software_licenses (vendor_id);

--> statement-breakpoint

-- ============================================================================
-- Grants for the least-privilege roles
-- ============================================================================
-- Granted explicitly rather than relying on the `isms` default privileges from
-- migration 0019: those apply only when the creating role matches, and a mismatch
-- surfaces as a 500 on the first insert in CI rather than anything legible.
--
-- THE NARROWING IS DONE WITH `REVOKE`, NOT A SMALLER `GRANT` — see migration 0022.
-- Migration 0019 ran `ALTER DEFAULT PRIVILEGES IN SCHEMA isms GRANT SELECT, INSERT,
-- UPDATE, DELETE ON TABLES`, so every table created here arrives holding all four
-- and a narrower GRANT would be a no-op that READS like a restriction.
--
--   * `vendor_criticality_levels` is reference data seeded above: SELECT only. The
--     tiers and their intervals are policy, changed by migration and in review, not
--     by whoever holds `vendor.manage`.
--   * `vendor_assessments` is append-only: SELECT and INSERT. An assessment that
--     can be edited afterwards is not evidence that the decision was reasonable.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON isms.vendors, isms.vendor_risks
      TO opshub_app, opshub_worker;

    REVOKE INSERT, UPDATE, DELETE ON isms.vendor_criticality_levels
      FROM opshub_app, opshub_worker;
    REVOKE UPDATE, DELETE ON isms.vendor_assessments
      FROM opshub_app, opshub_worker;
    -- SELECT is not implied by the revokes above; state it so a future reordering
    -- of this block cannot leave the tiers unreadable.
    GRANT SELECT ON isms.vendor_criticality_levels TO opshub_app, opshub_worker;
    GRANT SELECT, INSERT ON isms.vendor_assessments TO opshub_app, opshub_worker;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opshub_migrate') THEN
      GRANT ALL ON isms.vendor_criticality_levels,
                   isms.vendors,
                   isms.vendor_assessments,
                   isms.vendor_risks
        TO opshub_migrate;
    END IF;
  END IF;
END $$;
