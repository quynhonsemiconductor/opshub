/**
 * isms vendors — the supplier register, due-diligence assessments, and the risks they carry.
 *
 * ISO 27001 A.5.19–A.5.23 (supplier relationships) and GDPR Article 28 (processors). The question
 * this answers is the one an auditor asks in that order: who do we depend on, what did we check
 * before we depended on them, and when did we last look again.
 *
 * WHAT ALREADY EXISTED, AND WHY IT IS NOT THIS
 * -------------------------------------------
 * Two columns held vendor-shaped text before this: `licenses.software_licenses.vendor` (NOT NULL
 * varchar) and `compliance.software_catalog.publisher`. Neither is a vendor — they are labels on a
 * licence and on a piece of software, and "Microsoft" appearing in eleven licence rows is eleven
 * strings, not one supplier with one owner and one assessment history.
 *
 * `software_licenses.vendor_id` is added alongside the text rather than replacing it, which is the
 * same move `positions` made with `employees.job_title`: the free text stays because existing
 * screens read it and not every line item deserves a due-diligence file, and the real reference is
 * what makes "what do we buy from this supplier, and did anyone assess them" a join instead of a
 * string match. The pairing also produces the report worth having — money going to suppliers nobody
 * has assessed.
 *
 * FOUR TABLES, FOUR DIFFERENT QUESTIONS
 * ------------------------------------
 * `vendor_criticality_levels` is REFERENCE DATA: what each tier means, how the tiers RANK, and how
 * often a supplier at that tier must be reassessed. It exists for the same two reasons
 * `isms.classification_levels` does — the rank must be a column rather than an enum's declaration
 * order, and the review interval must be stated once instead of copied onto every vendor.
 *
 * `vendors` is the REGISTER, with the accountable owner and the contract window.
 *
 * `vendor_assessments` is WHAT WE CHECKED AND WHEN. One row per assessment, never updated in place:
 * last year's questionnaire result is the evidence that the decision made then was reasonable, and
 * overwriting it with this year's leaves the earlier decision unexplained.
 *
 * `vendor_risks` is WHICH REGISTER RISKS THIS SUPPLIER CARRIES — the same many-to-many shape as
 * `isms.risk_controls`, and the same anti-join payoff: a critical supplier with no risk recorded
 * against them is a gap in the assessment, surfaced by a report rather than assumed away.
 *
 * INVARIANTS THE DATABASE HOLDS
 * -----------------------------
 * 1. EVERY VENDOR HAS AN OWNER — `owner_id` is NOT NULL, on the same reasoning as
 *    `information_assets.owner_id`: "who owns this relationship" is the first thing asked and the
 *    last thing anyone volunteers.
 *
 * 2. AN ACTIVE PROCESSOR HAS A WRITTEN AGREEMENT — `ck_vendor_processor_agreement`. GDPR Article
 *    28(3) requires processing to be governed by a contract, so a supplier who handles personal data
 *    on our behalf cannot be `active` without one recorded. Deliberately scoped to `active`:
 *    registering a prospective processor before the agreement is signed is the normal order of
 *    events, and a blanket requirement would just push that record-keeping outside the system.
 *
 * 3. TERMINATION IS PAIRED WITH ITS DATE — `ck_vendor_terminated_pair`, the same status/timestamp
 *    pairing the incident module uses. A `terminated` row with no date cannot be reported on, and a
 *    date on a live supplier is a lie.
 *
 * 4. THE CONTRACT WINDOW RUNS FORWARD — `ck_vendor_contract_window`, fronted by the shared
 *    `assertDateOrder` guard so the caller gets a code instead of a 500.
 *
 * 5. CONDITIONS ARE REQUIRED WHEN AN ASSESSMENT IMPOSES THEM —
 *    `ck_vendor_assessment_conditions`. `pass_with_conditions` with nothing written down is the
 *    outcome people choose to avoid saying no, and it is worthless a year later.
 */
import {
  uuid,
  varchar,
  text,
  date,
  boolean,
  integer,
  smallint,
  timestamp,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { vendorAssessmentOutcomeEnum, vendorCriticalityEnum, vendorStatusEnum } from './enums';
// `ismsSchema` is declared ONCE, in `./isms`, and imported here: two `pgSchema('isms')` values would
// both be exported through `db/schema/index.ts` and collide on the name.
import { ismsSchema, risks } from './isms';

/**
 * What each criticality tier means, how it ranks, and how often it must be reassessed.
 *
 * Keyed BY THE ENUM, exactly as `classification_levels` is, so a tier and a label are one thing.
 * `review_interval_months` is the reason this is a table and not a comment: the next review date is
 * computed from it when an assessment is recorded, so the cadence is set in one place by policy
 * rather than typed in per vendor by whoever is filling the form.
 */
export const vendorCriticalityLevels = ismsSchema.table('vendor_criticality_levels', {
  code: vendorCriticalityEnum('code').primaryKey(),
  /** Higher matters more. THE authoritative ordering — see the enum's own comment. */
  rank: smallint('rank').notNull(),
  label: varchar('label', { length: 60 }).notNull(),
  description: text('description').notNull(),
  /** How often a supplier at this tier must be reassessed. Drives `review_due_on`. */
  reviewIntervalMonths: integer('review_interval_months').notNull(),
  /**
   * Whether a tier demands evidence beyond a questionnaire — an audit report, a certificate, a
   * penetration test summary. Read by the assessment screen to say what is expected.
   */
  requiresIndependentEvidence: boolean('requires_independent_evidence').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const vendors = ismsSchema.table(
  'vendors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Quoted in the register, in assessments and in audit findings, e.g. `VEN-014`. */
    reference: varchar('reference', { length: 40 }).notNull(),
    /** The name people use. */
    name: varchar('name', { length: 200 }).notNull(),
    /** The name on the contract, when it differs — which it usually does. */
    legalName: varchar('legal_name', { length: 200 }),
    /** What they actually do for us. The sentence that makes the criticality tier defensible. */
    services: text('services').notNull(),

    criticality: vendorCriticalityEnum('criticality')
      .notNull()
      .references(() => vendorCriticalityLevels.code, { onDelete: 'restrict' }),
    status: vendorStatusEnum('status').notNull().default('prospective'),

    /** The accountable employee. NOT NULL — an unowned supplier relationship is nobody's job. */
    ownerId: uuid('owner_id').notNull(),

    /**
     * Whether they process personal data on our behalf (GDPR Article 28).
     *
     * Paired with the agreement below by `ck_vendor_processor_agreement` once active.
     */
    dataProcessor: boolean('data_processor').notNull().default(false),
    /**
     * The data processing agreement, as a controlled document.
     *
     * No FK: `documents` is a separate schema and every other cross-schema reference in this
     * codebase is by id alone, so `VendorService.assertAgreementExists` refuses an id that names no
     * document — on both write paths, with a 404 naming the field. Note what
     * `ck_vendor_processor_agreement` below does NOT do: it asks whether this column is filled in,
     * never whether what it points at exists, and a wrong uuid satisfies it.
     */
    dataProcessingAgreementId: uuid('data_processing_agreement_id'),
    /** Where the data goes. The column an international-transfer question is answered from. */
    dataLocation: varchar('data_location', { length: 200 }),

    contractStartsOn: date('contract_starts_on'),
    contractEndsOn: date('contract_ends_on'),
    /** Days of notice required to exit. What an exit plan is built from. */
    noticePeriodDays: integer('notice_period_days'),

    /**
     * When the next reassessment is due.
     *
     * Written by the service from the tier's `review_interval_months` when an assessment is
     * recorded, never accepted from a caller — for the same reason no API accepts a risk score.
     */
    reviewDueOn: date('review_due_on'),

    terminatedAt: timestamp('terminated_at', { withTimezone: true }),
    /** Why the relationship ended. Required to terminate; see the service. */
    terminationReason: text('termination_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    referenceIdx: uniqueIndex('uq_vendor_reference').on(t.reference),
    statusIdx: index('ix_vendor_status_criticality').on(t.status, t.criticality),
    ownerIdx: index('ix_vendor_owner').on(t.ownerId),
    /** The review-due report's query, matching `ix_soa_review_due`. */
    reviewIdx: index('ix_vendor_review_due').on(t.reviewDueOn),
    /** "Which suppliers process personal data?" — the Article 30 question. */
    processorIdx: index('ix_vendor_processor').on(t.dataProcessor),
  }),
);

/**
 * One due-diligence assessment. Never updated in place.
 *
 * Last year's result is the evidence that the decision made last year was reasonable; overwriting it
 * with this year's leaves that decision unexplained. Corrections are new assessments, which is also
 * how a supplier who fixed their conditions is recorded as having done so.
 */
export const vendorAssessments = ismsSchema.table(
  'vendor_assessments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'cascade' }),
    assessedAt: timestamp('assessed_at', { withTimezone: true }).notNull().defaultNow(),
    assessedBy: uuid('assessed_by').notNull(),
    outcome: vendorAssessmentOutcomeEnum('outcome').notNull(),
    /** What was actually examined — the questionnaire, the SOC 2 report, the site visit. */
    scope: text('scope').notNull(),
    findings: text('findings'),
    /**
     * What must be fixed, and by when, for a `pass_with_conditions`.
     *
     * Required for that outcome by `ck_vendor_assessment_conditions`: an assessment that imposes
     * conditions nobody wrote down has imposed nothing.
     */
    conditions: text('conditions'),
    /**
     * Supporting evidence as a controlled document. No FK — cross-schema, like the agreement above.
     *
     * NOT CHECKED for existence, unlike `data_processing_agreement_id`: this comment used to claim it
     * was, and it never has been. Stated rather than quietly fixed because the two are not the same
     * risk — the agreement is what makes processing lawful under Article 28, while a dangling
     * evidence id makes one assessment row unverifiable. Closing it belongs with the assessment
     * path's own review.
     */
    evidenceDocumentId: uuid('evidence_document_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    /**
     * Latest-first reads, `id` last: a bulk import gives several assessments the same timestamp, so
     * without the tiebreaker paging a long history drops and repeats rows.
     */
    vendorIdx: index('ix_vendor_assessment_vendor').on(t.vendorId, t.assessedAt, t.id),
  }),
);

/**
 * Which register risks this supplier carries.
 *
 * Many-to-many by nature and modelled exactly like `isms.risk_controls`: one supplier raises several
 * risks and one risk can involve several suppliers. `isms.risks.category` already accepts the free
 * text `supplier`, which is how a risk is grouped — this is how it is CONNECTED, and the difference
 * is that a connection can be counted.
 */
export const vendorRisks = ismsSchema.table(
  'vendor_risks',
  {
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'cascade' }),
    riskId: uuid('risk_id')
      .notNull()
      .references(() => risks.id, { onDelete: 'cascade' }),
    /** Who linked them, and when — the decision's own small audit trail. */
    linkedBy: uuid('linked_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    /** Natural key: the same risk linked twice to one vendor is still one link. */
    pk: primaryKey({ columns: [t.vendorId, t.riskId] }),
    /** "Which suppliers does this risk involve?" — the direction a risk review reads from. */
    riskIdx: index('ix_vendor_risk_risk').on(t.riskId),
  }),
);
