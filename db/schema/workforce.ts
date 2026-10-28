/**
 * workforce schema — timesheets, leave, overtime and night/on-call shift logs.
 */
import {
  pgSchema,
  uuid,
  varchar,
  text,
  date,
  timestamp,
  integer,
  numeric,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import {
  leaveAccrualMethodEnum,
  leaveDayPortionEnum,
  leaveStatusEnum,
  leaveTypeEnum,
  overtimeStatusEnum,
  shiftTypeEnum,
  timesheetStatusEnum,
  wfhStatusEnum,
} from './enums';
import { requestItems } from './requests';

export const workforceSchema = pgSchema('workforce');

export const timesheets = workforceSchema.table(
  'timesheets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id').notNull(),
    workDate: date('work_date').notNull(),
    /** Worked minutes for the day (kept as integer to avoid float drift). */
    minutesWorked: integer('minutes_worked').notNull().default(0),
    note: varchar('note', { length: 500 }),
    status: timesheetStatusEnum('status').notNull().default('draft'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    approvedBy: uuid('approved_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    employeeDateIdx: index('ix_timesheet_employee_date').on(t.employeeId, t.workDate),
    statusIdx: index('ix_timesheet_status').on(t.status),
  }),
);

export const leaveRequests = workforceSchema.table(
  'leave_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id').notNull(),
    leaveType: leaveTypeEnum('leave_type').notNull(),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    /**
     * Which part of the first and last day the window covers. Both `full_day` unless the request
     * is part-day — see `domain/leave-window.ts` for the rules, and migration 0028 for the CHECKs
     * that keep every window in exactly one spelling.
     */
    startPortion: leaveDayPortionEnum('start_portion').notNull().default('full_day'),
    endPortion: leaveDayPortionEnum('end_portion').notNull().default('full_day'),
    reason: text('reason'),
    /**
     * Working days this request costs, computed at SUBMIT time and then frozen.
     *
     * Frozen deliberately: the holiday calendar is editable, so recomputing on read would
     * silently restate what an approved request cost — adding a public holiday inside a window
     * someone already took would change their balance months later. A measurement of a past
     * decision is not a derived value.
     *
     * Nullable only for rows predating the column, which migration 0014 backfills from a weekday
     * count — no holiday data existed for those dates to apply.
     */
    workingDays: numeric('working_days', { precision: 5, scale: 2 }),
    /** S3 key for a supporting document (e.g. medical certificate for sick leave). */
    documentStorageKey: varchar('document_storage_key', { length: 512 }),
    status: leaveStatusEnum('status').notNull().default('pending'),
    reviewerId: uuid('reviewer_id'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    requestId: uuid('request_id').references(() => requestItems.id, { onDelete: 'set null' }),
  },
  (t) => ({
    employeeIdx: index('ix_leave_employee').on(t.employeeId, t.startDate),
    statusIdx: index('ix_leave_status').on(t.status),
  }),
);

export const overtimeEntries = workforceSchema.table(
  'overtime_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id').notNull(),
    workDate: date('work_date').notNull(),
    hours: numeric('hours', { precision: 4, scale: 2 }).notNull(),
    reason: text('reason').notNull(),
    status: overtimeStatusEnum('status').notNull().default('pending'),
    reviewerId: uuid('reviewer_id'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    requestId: uuid('request_id').references(() => requestItems.id, { onDelete: 'set null' }),
  },
  (t) => ({
    employeeIdx: index('ix_overtime_employee').on(t.employeeId, t.workDate),
    statusIdx: index('ix_overtime_status').on(t.status),
  }),
);

export const shiftLogs = workforceSchema.table(
  'shift_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id').notNull(),
    shiftType: shiftTypeEnum('shift_type').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    note: varchar('note', { length: 500 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    employeeIdx: index('ix_shift_employee').on(t.employeeId, t.startsAt),
    typeIdx: index('ix_shift_type').on(t.shiftType, t.startsAt),
  }),
);

/**
 * Public holidays — reference data, excluded from every working-day calculation.
 *
 * `region` is NOT NULL with an 'ALL' default rather than nullable, so `(date, region)` can be a
 * plain unique index. A nullable region would not dedupe: Postgres treats NULLs as distinct in a
 * unique index, so the same national holiday could be inserted any number of times.
 */
export const holidays = workforceSchema.table(
  'holidays',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    date: date('date').notNull(),
    name: varchar('name', { length: 160 }).notNull(),
    /** 'ALL' for a national holiday, or a region code for a local one. */
    region: varchar('region', { length: 32 }).notNull().default('ALL'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    dateRegionIdx: uniqueIndex('uq_holiday_date_region').on(t.date, t.region),
    dateIdx: index('ix_holiday_date').on(t.date),
  }),
);

/**
 * Annual leave entitlement per employee, per leave type, per year.
 *
 * A leave type with NO row here is UNTRACKED — unpaid and compassionate leave are approved on
 * their merits, not against an allowance — so the balance check skips them rather than treating a
 * missing row as zero days and refusing every request.
 *
 * Balance is DERIVED (`granted + carriedOver - consumed`), never stored. A stored balance drifts
 * the first time a request is cancelled, back-dated or corrected, and then no query can tell you
 * whether the number or the requests are wrong.
 */
export const leaveEntitlements = workforceSchema.table(
  'leave_entitlements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id').notNull(),
    leaveType: leaveTypeEnum('leave_type').notNull(),
    /** Calendar year the grant applies to. */
    year: integer('year').notNull(),
    grantedDays: numeric('granted_days', { precision: 5, scale: 2 }).notNull(),
    /** Unused days brought forward from the previous year, if the policy allows it. */
    carriedOverDays: numeric('carried_over_days', { precision: 5, scale: 2 })
      .notNull()
      .default('0'),
    /**
     * When those carried days stop being available.
     *
     * Written by the carry-over run from the policy's `carry_over_expiry_months`; null means they
     * never expire. Carried days are DEDUCTED from availability once this date has passed rather
     * than being zeroed on it: the row stays honest about what was carried, and no cron has to fire
     * on the right morning for the balance to be correct.
     */
    carriedOverExpiresOn: date('carried_over_expires_on'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniq: uniqueIndex('uq_leave_entitlement').on(t.employeeId, t.leaveType, t.year),
    employeeIdx: index('ix_leave_entitlement_employee').on(t.employeeId, t.year),
  }),
);

/**
 * How each leave type accrues, and what it may carry over — reference data.
 *
 * WHAT THIS TABLE DOES NOT HOLD
 * -----------------------------
 * It carries no days-per-year. `leave_entitlements.granted_days` is already the year's entitlement,
 * set by HR and pro-rated by hand for a mid-year joiner — and two sources of truth for "how many
 * days" is exactly the drift this module's own docblock warns about for balances. So the policy
 * decides HOW those days become available and WHAT survives into the next year, and nothing else.
 *
 * A LEAVE TYPE WITH NO ROW HERE BEHAVES AS IT ALWAYS DID: `annual_grant`, no carry-over. That
 * default is what keeps this migration behaviour-preserving for every existing entitlement, and it
 * is why there is deliberately no test asserting the enum is fully covered — unlike the
 * classification, criticality and severity tables, an absent row here is a MEANING rather than a gap.
 *
 * Keyed by the enum, as those three are, so a policy and a leave type are one thing.
 */
export const leavePolicies = workforceSchema.table('leave_policies', {
  leaveType: leaveTypeEnum('leave_type').primaryKey(),
  accrualMethod: leaveAccrualMethodEnum('accrual_method').notNull().default('annual_grant'),
  /**
   * The most days that may be carried into the next year. `0` means none.
   *
   * A cap rather than a boolean because "carry over up to five days" is the shape every policy
   * actually takes, and a boolean would put the number somewhere else.
   */
  carryOverMaxDays: numeric('carry_over_max_days', { precision: 5, scale: 2 })
    .notNull()
    .default('0'),
  /**
   * How many months into the new year carried days survive. Null means they never expire.
   *
   * Paired with the cap by `ck_leave_policy_expiry_needs_carry_over`: an expiry on a policy that
   * carries nothing describes nothing.
   */
  carryOverExpiryMonths: integer('carry_over_expiry_months'),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One work-from-home REQUEST: a date range, costed in working days, approved as a whole.
 *
 * Mirrors `leave_requests` on purpose — the WIO calendar, the overlap rules and the review flow ask
 * the same questions of both, so a second spelling of "a dated request somebody approves" would
 * drift from the first. No portions (WFH is whole days) and no entitlement (WFH costs no allowance).
 *
 * The stored fact is a REQUEST, not a day: being in the office is still the default, but a day now
 * counts as WFH only when a request covering it is approved — a manager signs off, nobody ticks
 * their own box. `working_days` is frozen at submit for the same reason leave's is: the holiday
 * calendar is editable, and recomputing would restate what an approved request covers.
 */
export const wfhRequests = workforceSchema.table(
  'wfh_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id').notNull(),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    /** Working days the window covers, computed at submit and then frozen. Whole days only. */
    workingDays: integer('working_days').notNull(),
    reason: text('reason'),
    status: wfhStatusEnum('status').notNull().default('pending'),
    reviewerId: uuid('reviewer_id'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    requestId: uuid('request_id').references(() => requestItems.id, { onDelete: 'set null' }),
  },
  (t) => ({
    employeeIdx: index('ix_wfh_employee').on(t.employeeId, t.startDate),
    statusIdx: index('ix_wfh_status').on(t.status),
  }),
);
