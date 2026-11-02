/**
 * positions schema — job positions, approved headcount, and who occupies what over time.
 *
 * WHY THIS EXISTS WHEN `employees` ALREADY HAS `job_title` AND `department`
 * ------------------------------------------------------------------------
 * Those two are free text on the person. They answer "what does Mai do?" and nothing else: you
 * cannot ask how many QA Engineers were approved versus filled, what a vacancy is, or what the
 * role required when someone held it two years ago. A position is the ROLE as an entity, separate
 * from whoever currently occupies it.
 *
 * It is also the hook the rest of the roadmap needs. QMS competency is "training required for THIS
 * POSITION", and an employment contract is a contract FOR a position — both of which need the role
 * to outlive its occupant. Building those against `job_title` would mean matching on a string.
 *
 * ASSIGNMENT IS A HISTORY, NOT A COLUMN. `employee_positions` is append-mostly with an open-ended
 * `effective_to`, so "who held this position in March" stays answerable after three reorganisations.
 * A `position_id` column on `employees` would overwrite that on every move.
 *
 * `employees.job_title` is deliberately NOT dropped. It is written by the Entra sync and read by
 * screens that predate this table, so removing it would be a second change riding along on this
 * one; the position title is authoritative where an assignment exists.
 */
import { sql } from 'drizzle-orm';
import {
  pgSchema,
  uuid,
  varchar,
  text,
  integer,
  date,
  timestamp,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { positionStatusEnum, rankBenefitCodeEnum } from './enums';

export const positionsSchema = pgSchema('roles');

/**
 * Seniority ranks (1 = most junior) — what a position's `level` was as free text, made a row.
 *
 * A RANK IS A TABLE, NOT A STRING, because the things that hang off it need a key: the benefits in
 * `rank_benefits` (the weekly WFH allowance is the first) are looked up by rank, and a free-text level
 * ("Level 2", "L2", "lvl 2") cannot be matched reliably. `ordinal` orders the ranks and is unique, so
 * two ranks can never claim the same seniority.
 */
export const jobRanks = positionsSchema.table(
  'job_ranks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Seniority order, 1 = most junior. Unique: one rank per step. */
    ordinal: integer('ordinal').notNull(),
    name: varchar('name', { length: 80 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ordinalIdx: uniqueIndex('uq_job_rank_ordinal').on(t.ordinal),
    nameIdx: uniqueIndex('uq_job_rank_name').on(sql`lower(${t.name})`),
  }),
);

/**
 * What a rank entitles its holders to: one row per (rank, benefit). The row's absence means the rank has
 * no such benefit — it is NOT the same as a value of zero that someone chose, but both answer "none".
 */
export const rankBenefits = positionsSchema.table(
  'rank_benefits',
  {
    rankId: uuid('rank_id')
      .notNull()
      .references(() => jobRanks.id, { onDelete: 'cascade' }),
    benefitCode: rankBenefitCodeEnum('benefit_code').notNull(),
    /** The benefit's amount; its unit is named by the code (`wfh_weekly_days` → days per week). */
    value: integer('value').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.rankId, t.benefitCode] }),
  }),
);

export const positions = positionsSchema.table(
  'roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Stable identifier used in headcount plans and contracts, e.g. `ENG-QA-02`. */
    code: varchar('code', { length: 32 }).notNull(),
    title: varchar('title', { length: 160 }).notNull(),
    department: varchar('department', { length: 120 }).notNull(),
    /** Seniority rank. Null for a position nobody has ranked; RESTRICT, so a rank in use cannot be deleted. */
    rankId: uuid('rank_id').references(() => jobRanks.id, { onDelete: 'restrict' }),
    /**
     * Approved headcount — how many people may hold this position at once.
     *
     * Enforced in the service, NOT by a constraint, and the difference is worth stating: this is a
     * count across rows filtered by `effective_to IS NULL`, which no unique index can express. The
     * service therefore counts inside the assignment transaction, so two concurrent assignments
     * cannot both see a free slot.
     */
    headcount: integer('headcount').notNull().default(1),
    description: text('description'),
    status: positionStatusEnum('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    codeIdx: uniqueIndex('uq_role_code').on(t.code),
    departmentIdx: index('ix_role_department').on(t.department),
    statusIdx: index('ix_role_status').on(t.status),
    rankIdx: index('ix_role_rank').on(t.rankId),
  }),
);

export const employeePositions = positionsSchema.table(
  'employee_roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id').notNull(),
    positionId: uuid('role_id')
      .notNull()
      .references(() => positions.id, { onDelete: 'restrict' }),
    effectiveFrom: date('effective_from').notNull(),
    /** Open-ended while current. Set on transfer or departure — the row is never deleted. */
    effectiveTo: date('effective_to'),
    /** Why the assignment ended, for the record: promotion, transfer, offboarding. */
    endReason: varchar('end_reason', { length: 120 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    /**
     * ONE CURRENT POSITION PER EMPLOYEE, as a database guarantee.
     *
     * Partial unique index over (employee_id) where the assignment is still open. History rows are
     * unconstrained, so a person can hold the same position twice over a career, but cannot occupy
     * two at once — which is what makes "their position" a question with one answer.
     */
    currentIdx: uniqueIndex('uq_employee_current_role')
      .on(t.employeeId)
      .where(sql`effective_to IS NULL`),
    employeeIdx: index('ix_employee_role_employee').on(t.employeeId, t.effectiveFrom),
    positionIdx: index('ix_employee_role_role').on(t.positionId),
  }),
);
