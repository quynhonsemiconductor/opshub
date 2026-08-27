/**
 * isms controls — the control catalogue, the Statement of Applicability, and the link to risks.
 *
 * THREE TABLES, BECAUSE THEY ANSWER THREE DIFFERENT QUESTIONS
 * ----------------------------------------------------------
 * `controls` is REFERENCE DATA: what Annex A contains, plus whatever the organisation adds. It says
 * nothing about this company. It is seeded, it is nearly immutable, and two organisations would hold
 * identical rows.
 *
 * `soa_entries` is the DECISION about each control — applicable or not, why, how far implemented, who
 * owns it, when it is next reviewed. That is the Statement of Applicability, and it is the single
 * document an ISO 27001 auditor asks for first. One row per control, enforced by
 * `uq_soa_control`: the SoA is a statement, and a control with two of them has none.
 *
 * `risk_controls` is WHICH CONTROLS TREAT WHICH RISK. Many-to-many by nature — one control mitigates
 * several risks and one risk needs several controls — and the join is what turns "we have controls"
 * into "this risk is treated by these controls", which is the question a treatment plan actually
 * answers.
 *
 * WHY NOT COLUMNS ON `controls`. Merging the decision into the catalogue would mean re-seeding Annex
 * A could overwrite the organisation's justifications, and it would make "which controls have we not
 * yet decided about?" unanswerable — an absent SoA row is exactly that state, and a NULL column
 * could not distinguish it from "decided, no comment".
 *
 * APPLICABILITY AND STATUS CANNOT DISAGREE — `ck_soa_applicability` pairs `applicable = false` with
 * `not_applicable`, so "excluded but implemented" is unrepresentable rather than merely discouraged.
 * A JUSTIFICATION IS ALWAYS REQUIRED: for an included control it is the rationale, for an excluded
 * one it is the exclusion reason the standard demands. Both are the same field because both are the
 * same obligation.
 */
import {
  uuid,
  varchar,
  text,
  date,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { controlImplementationStatusEnum, controlSourceEnum, controlThemeEnum } from './enums';
// `ismsSchema` is declared ONCE, in `./isms`, and imported here: two `pgSchema('isms')` values would
// both be exported through `db/schema/index.ts` and collide on the name.
import { ismsSchema, risks } from './isms';

export const controls = ismsSchema.table(
  'controls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The standard's own reference, e.g. `A.5.1`. Quoted in every audit conversation. */
    reference: varchar('reference', { length: 40 }).notNull(),
    title: varchar('title', { length: 300 }).notNull(),
    description: text('description'),
    theme: controlThemeEnum('theme').notNull(),
    source: controlSourceEnum('source').notNull().default('annex_a'),
    /**
     * Retired controls stay in the catalogue.
     *
     * A superseded edition of the standard still has to be explicable — an SoA entry from last
     * year's audit references a control by id, and deleting it would orphan the evidence.
     */
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    referenceIdx: uniqueIndex('uq_control_reference').on(t.reference),
    themeIdx: index('ix_control_theme').on(t.theme),
  }),
);

export const soaEntries = ismsSchema.table(
  'soa_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    controlId: uuid('control_id')
      .notNull()
      .references(() => controls.id, { onDelete: 'restrict' }),
    /** Included in the ISMS scope, or excluded. Paired with `status` by `ck_soa_applicability`. */
    applicable: boolean('applicable').notNull(),
    /**
     * Why. Required either way — the rationale for including it, or the exclusion reason ISO 27001
     * asks for by name. One field because it is one obligation.
     */
    justification: text('justification').notNull(),
    status: controlImplementationStatusEnum('status').notNull(),
    /** How it is actually done here. Free text: the implementation, not the requirement. */
    implementationNote: text('implementation_note'),
    /**
     * The controlled document that evidences it — a policy, a procedure, a work instruction.
     *
     * No FK: `documents` is a separate schema, so `DocumentsService.assertExist` is what makes this
     * reference real — called from the route that accepts it. A dangling id would be a record that
     * reads as complete evidence.
     */
    evidenceDocumentId: uuid('evidence_document_id'),
    /** Accountable for the control being in place. Not the person who wrote the SoA entry. */
    ownerId: uuid('owner_id'),
    lastReviewedAt: timestamp('last_reviewed_at', { withTimezone: true }),
    reviewDueOn: date('review_due_on'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    /** One statement per control. Two would mean the SoA says two things at once. */
    controlIdx: uniqueIndex('uq_soa_control').on(t.controlId),
    statusIdx: index('ix_soa_status').on(t.applicable, t.status),
    ownerIdx: index('ix_soa_owner').on(t.ownerId),
    /** The review-due report's query. */
    reviewIdx: index('ix_soa_review_due').on(t.reviewDueOn),
  }),
);

export const riskControls = ismsSchema.table(
  'risk_controls',
  {
    riskId: uuid('risk_id')
      .notNull()
      .references(() => risks.id, { onDelete: 'cascade' }),
    controlId: uuid('control_id')
      .notNull()
      .references(() => controls.id, { onDelete: 'restrict' }),
    /** Who linked them, and when — the treatment decision's own small audit trail. */
    linkedBy: uuid('linked_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    /** Natural key: the same control linked twice to one risk is still one link. */
    pk: primaryKey({ columns: [t.riskId, t.controlId] }),
    /** "Which risks does this control treat?" — the direction the SoA justification needs. */
    controlIdx: index('ix_risk_control_control').on(t.controlId),
  }),
);
