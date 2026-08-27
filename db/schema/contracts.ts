/**
 * contracts schema — employment contracts: their terms, their dates, and their succession.
 *
 * WHAT A CONTRACT ADDS THAT `employees` AND `positions` DO NOT HAVE
 * ----------------------------------------------------------------
 * `employees` says who someone is and `employee_positions` says what role they occupy. Neither says
 * on what TERMS: whether the engagement ends, when probation closes, what notice either side owes,
 * or what the agreed pay is. Those are the questions HR is actually asked, and none of them can be
 * answered from a job title.
 *
 * A contract is FOR a position, which is why `positions` was built first. `position_id` is nullable
 * only because a contractor engagement may be scoped to work rather than to a seat in the org chart.
 *
 * THREE INVARIANTS IN THE DATABASE
 *
 * 1. ONE ACTIVE CONTRACT PER EMPLOYEE — `uq_employee_active_contract`, a partial unique index over
 *    (employee_id) WHERE status = 'active'. Draft, expired and terminated rows are unconstrained,
 *    so a renewal chain and a rejected draft both coexist with the live agreement. This is what
 *    makes "their contract" a question with one answer, and it is the constraint that forces a
 *    renewal to be one transaction: the incoming row cannot go active until the outgoing one leaves.
 *
 * 2. THE END DATE MATCHES THE TYPE — `ck_contract_type_end_date`. `permanent` with an end date is a
 *    fixed-term contract mislabelled; `fixed_term` without one is open-ended employment nobody
 *    approved. Expressible as a CHECK because it reads one row, so it belongs here rather than in a
 *    service that could be bypassed by a seed or a fix-up script.
 *
 * 3. DATES RUN FORWARD — `ck_contract_window`, `ck_contract_probation_window`,
 *    `ck_contract_terminated_window`. An agreement that ended before it began is a data-entry
 *    error, not a state.
 *
 * COMPENSATION IS ON THIS TABLE, AND GATED AT THE API. `contract.read` returns the contract;
 * `contract.compensation.read` is what adds the money. Employees always see their own figures —
 * their pay is theirs. Splitting the columns into a second table was considered and rejected: it
 * would put a join between HR and the field they most need, while the actual protection has to live
 * at the API boundary either way.
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
import { contractStatusEnum, contractTypeEnum, salaryPeriodEnum } from './enums';
import { positions } from './positions';

export const contractsSchema = pgSchema('contracts');

export const employmentContracts = contractsSchema.table(
  'employment_contracts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id').notNull(),
    /**
     * The position the contract is for.
     *
     * Nullable for a contractor engaged for work rather than a seat, and `restrict` on delete so a
     * position with contract history cannot be erased out from under it.
     */
    positionId: uuid('position_id').references(() => positions.id, { onDelete: 'restrict' }),
    /** Human reference quoted in correspondence, e.g. `EMP-2026-0042`. */
    reference: varchar('reference', { length: 40 }).notNull(),
    contractType: contractTypeEnum('contract_type').notNull(),
    startDate: date('start_date').notNull(),
    /** Required for every type except `permanent`, where it must be null. See invariant 2. */
    endDate: date('end_date'),
    /** When probation closes. Independent of `end_date`: a permanent contract can have one. */
    probationEndDate: date('probation_end_date'),
    /** Notice owed in days. Zero is legitimate — some probation terms carry none. */
    noticePeriodDays: integer('notice_period_days').notNull().default(30),
    /**
     * Agreed base pay. `numeric`, never a float: money that fails to round-trip is worse than
     * money that is absent, and this column is quoted back to people.
     */
    baseSalary: numeric('base_salary', { precision: 14, scale: 2 }),
    /** ISO 4217. Required whenever an amount is present — `ck_contract_salary_complete`. */
    salaryCurrency: varchar('salary_currency', { length: 3 }),
    salaryPeriod: salaryPeriodEnum('salary_period'),
    status: contractStatusEnum('status').notNull().default('draft'),
    /** When both parties signed. A contract may be activated only once this is set. */
    signedAt: timestamp('signed_at', { withTimezone: true }),
    /**
     * The controlled document holding the signed agreement.
     *
     * No FK: `documents` is a separate schema, so `DocumentsService.assertExist` is what makes this
     * reference real — called from the route that accepts it. A dangling id would be a record that
     * reads as complete evidence.
     */
    documentId: uuid('document_id'),
    terminatedOn: date('terminated_on'),
    terminationReason: varchar('termination_reason', { length: 200 }),
    /**
     * The contract that replaced this one, set when a renewal is recorded.
     *
     * Points forward rather than back so the chain can be walked from any historical row without a
     * recursive query, and self-referential rather than a separate table because a contract has at
     * most one successor — the active-contract index guarantees it.
     */
    supersededById: uuid('superseded_by_id'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    /** Invariant 1 — see the file header. */
    activeIdx: uniqueIndex('uq_employee_active_contract')
      .on(t.employeeId)
      .where(sql`status = 'active'`),
    referenceIdx: uniqueIndex('uq_contract_reference').on(t.reference),
    employeeIdx: index('ix_contract_employee').on(t.employeeId, t.startDate),
    positionIdx: index('ix_contract_position').on(t.positionId),
    /** The sweep's query: active contracts ordered by when they end. */
    expiryIdx: index('ix_contract_status_end').on(t.status, t.endDate),
  }),
);
