/**
 * training schema — the course catalogue, what each POSITION requires, and who has completed what.
 *
 * WHY THREE TABLES AND NOT A `trainings` LIST ON THE EMPLOYEE
 * ----------------------------------------------------------
 * "Mai did fire safety in March" is a fact about a person. The questions actually asked are about
 * the ORG: which courses does a QA Engineer have to hold, who is missing one, whose certificate
 * expires this quarter. None of those is answerable from a list on an employee row, because the
 * requirement does not live on the person — it lives on the POSITION they occupy, which is exactly
 * the ISO 9001 / ISO 27001 competency framing ("training required for THIS ROLE").
 *
 * So: `courses` is the catalogue, `position_requirements` says which position needs which course,
 * and `records` says who completed what and until when. The gap report is the join, and it stays
 * correct through a transfer because it reads the employee's CURRENT position rather than a
 * snapshot copied onto the record.
 *
 * VALIDITY IS ON THE COURSE, EXPIRY IS ON THE RECORD. `courses.validity_months` is the rule
 * ("first aid lapses after 24 months"); `records.expires_on` is the consequence, computed once at
 * completion and then FROZEN. Recomputing it on read would silently restate history every time
 * somebody edited the course — the same reason a leave request freezes its day count at submit.
 *
 * CERTIFICATES ARE ATTACHMENTS, not a key column. A completed course can be evidenced by a
 * certificate plus a transcript plus a score report, so files hang off `storage.attachments` keyed
 * on `('training_record', record_id)`. See that table's header for why the 1:1 surfaces stay as
 * they are.
 */
import { sql } from 'drizzle-orm';
import {
  pgSchema,
  uuid,
  varchar,
  text,
  integer,
  numeric,
  date,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { trainingRecordStatusEnum, trainingRequirementKindEnum } from './enums';
import { positions } from './positions';

export const trainingSchema = pgSchema('training');

export const trainingCourses = trainingSchema.table(
  'courses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Quoted in competency matrices and audit findings, e.g. `ISMS-AWARE-01`. */
    code: varchar('code', { length: 32 }).notNull(),
    title: varchar('title', { length: 200 }).notNull(),
    /** Free text: `information_security`, `quality`, `safety` — companies group differently. */
    category: varchar('category', { length: 64 }).notNull(),
    provider: varchar('provider', { length: 160 }),
    description: text('description'),
    /**
     * How long a completion stays valid, in months. NULL means it never lapses.
     *
     * Months rather than days because certifications are stated that way ("valid for two years"),
     * and adding months to a date is exact where 730 days drifts across leap years.
     */
    validityMonths: integer('validity_months'),
    /** Retired courses stay in the catalogue: past records still reference them. */
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    codeIdx: uniqueIndex('uq_training_course_code').on(t.code),
    categoryIdx: index('ix_training_course_category').on(t.category),
  }),
);

export const trainingPositionRequirements = trainingSchema.table(
  'role_requirements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    positionId: uuid('role_id')
      .notNull()
      .references(() => positions.id, { onDelete: 'cascade' }),
    courseId: uuid('course_id')
      .notNull()
      .references(() => trainingCourses.id, { onDelete: 'restrict' }),
    kind: trainingRequirementKindEnum('kind').notNull().default('mandatory'),
    /**
     * How long after taking up the position the course must be completed.
     *
     * NULL means "before starting". A grace period is what makes the gap report usable: without
     * one, every new hire is non-compliant on day one and the report is noise.
     */
    graceDays: integer('grace_days'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    /** One requirement row per (position, course) — listing it twice says nothing new. */
    uniqueIdx: uniqueIndex('uq_training_requirement').on(t.positionId, t.courseId),
    positionIdx: index('ix_training_requirement_role').on(t.positionId),
    courseIdx: index('ix_training_requirement_course').on(t.courseId),
  }),
);

export const trainingRecords = trainingSchema.table(
  'records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id').notNull(),
    courseId: uuid('course_id')
      .notNull()
      .references(() => trainingCourses.id, { onDelete: 'restrict' }),
    completedOn: date('completed_on').notNull(),
    /** Frozen at completion from `courses.validity_months`. NULL = does not lapse. */
    expiresOn: date('expires_on'),
    /** Whatever the certificate says — a mark, a percentage, `PASS`. Free text on purpose. */
    result: varchar('result', { length: 64 }),
    score: numeric('score', { precision: 5, scale: 2 }),
    status: trainingRecordStatusEnum('status').notNull().default('valid'),
    /** Who checked the evidence. NULL until somebody with `training.manage` has. */
    verifiedBy: uuid('verified_by'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    /** Set when a later completion replaces this one — the retraining chain. */
    supersededById: uuid('superseded_by_id'),
    revokedReason: varchar('revoked_reason', { length: 200 }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    /**
     * ONE CURRENT RECORD PER (EMPLOYEE, COURSE) — partial unique index over the rows that have not
     * been superseded or revoked.
     *
     * Retraining is normal, so history must accumulate; what must not accumulate is two rows both
     * claiming to be the live answer to "is Mai's fire safety current?". Superseding is therefore
     * forced to happen in the same transaction as the new completion, exactly as a position
     * transfer is: the index makes the other order impossible rather than merely discouraged.
     */
    currentIdx: uniqueIndex('uq_training_record_current')
      .on(t.employeeId, t.courseId)
      .where(sql`superseded_by_id IS NULL AND status <> 'revoked'`),
    employeeIdx: index('ix_training_record_employee').on(t.employeeId, t.completedOn),
    courseIdx: index('ix_training_record_course').on(t.courseId),
    /** The expiry report's query: live records ordered by when they lapse. */
    expiryIdx: index('ix_training_record_expiry').on(t.status, t.expiresOn),
  }),
);
