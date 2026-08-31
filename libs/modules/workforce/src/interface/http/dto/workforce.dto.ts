import { ApiProperty } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PaginationQuerySchema } from '@shared-kernel';
import {
  timesheetStatusEnum,
  leaveDayPortionEnum,
  leaveTypeEnum,
  leaveStatusEnum,
  overtimeStatusEnum,
  shiftTypeEnum,
} from '@db/schema/enums';

// `z.string().date()`, not a shape regex: it is the idiom the rest of the codebase uses and it
// rejects impossible dates like `2026-02-31` that a regex accepts.
const dateStr = z.string().date();

// Same idiom for clock times. `.time()` also accepts a seconds/fraction part, which is tolerated
// rather than forbidden: the column counts whole minutes, so anything finer is truncated by
// `minutesOfDay` below.
const timeStr = z.string().time();

/** An `HH:mm` clock time (anything finer truncated) as minutes past midnight. */
function minutesOfDay(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

/**
 * Minutes on the clock face between `start` and `end`.
 *
 * OVERNIGHT RULE, decided once here: `end < start` is an overnight shift, not an error — a
 * 22:00→06:00 shift is 480 minutes worked, and `workDate` is the day the shift STARTED, so which
 * side of midnight it crosses is the caller's business. The one refused case is `end === start`:
 * a zero-minute shift is a typo, not a midnight-to-midnight one, and the schema's refine rejects
 * it. The modulo also caps every span at 1439 minutes, so a derived value can never breach the
 * 1440-minute ceiling `minutesWorked` is validated against.
 */
function spanMinutes(start: string, end: string): number {
  return (minutesOfDay(end) - minutesOfDay(start) + 1440) % 1440;
}

// ── Timesheets ───────────────────────────────────────────────────────────────
export const CreateTimesheetSchema = z
  .object({
    workDate: dateStr,
    minutesWorked: z.number().int().min(0).max(1440),
    startTime: timeStr.optional(),
    endTime: timeStr.optional(),
    note: z.string().max(500).optional(),
  })
  .refine((v) => (v.startTime === undefined) === (v.endTime === undefined), {
    message: 'startTime and endTime must be given together',
    path: ['startTime'],
  })
  .refine(
    (v) => !v.startTime || !v.endTime || minutesOfDay(v.startTime) !== minutesOfDay(v.endTime),
    {
      message: 'startTime and endTime must differ — equal times describe a zero-minute shift',
      path: ['endTime'],
    },
  )
  /**
   * The value the controller receives carries NO times: they are input vocabulary only, and
   * everything downstream — service, repository, audit, response — keeps reading
   * `minutesWorked`, which is why no schema or column had to change for them. When both times
   * are present they WIN: an explicitly given `minutesWorked` is recomputed from the span rather
   * than trusted, because two numbers for one day is a disagreement the API settles, not
   * persists. Without times `minutesWorked` passes through exactly as before.
   */
  .transform((v) => {
    if (v.startTime && v.endTime) {
      return {
        workDate: v.workDate,
        minutesWorked: spanMinutes(v.startTime, v.endTime),
        note: v.note,
      };
    }
    return { workDate: v.workDate, minutesWorked: v.minutesWorked, note: v.note };
  });
export class CreateTimesheetDto extends createZodDto(CreateTimesheetSchema) {}

/**
 * The whole batch is validated by this one parse — one bad entry fails all of them here, before
 * the service is ever reached, which is the first half of the bulk endpoint's all-or-nothing
 * promise. The second half (one INSERT, one transaction) lives in the repository.
 */
export const BulkCreateTimesheetsSchema = z.object({
  entries: z.array(CreateTimesheetSchema).min(1).max(50),
});
export class BulkCreateTimesheetsDto extends createZodDto(BulkCreateTimesheetsSchema) {}

export const ListTimesheetsQuerySchema = z
  .object({
    employeeId: z.string().uuid().optional(),
    status: z.enum(timesheetStatusEnum.enumValues).optional(),
    /** Inclusive lower and upper bounds on `workDate` — "this pay period", not "this instant". */
    dateFrom: dateStr.optional(),
    dateTo: dateStr.optional(),
  })
  .merge(PaginationQuerySchema)
  .refine((v) => !v.dateFrom || !v.dateTo || v.dateFrom <= v.dateTo, {
    message: 'dateFrom must be on or before dateTo',
    path: ['dateTo'],
  });
export class ListTimesheetsQueryDto extends createZodDto(ListTimesheetsQuerySchema) {}

export class TimesheetResponseDto {
  id!: string;
  employeeId!: string;
  workDate!: string;
  minutesWorked!: number;
  note!: string | null;
  @ApiProperty({ enum: timesheetStatusEnum.enumValues })
  status!: (typeof timesheetStatusEnum.enumValues)[number];
  submittedAt!: string | null;
  approvedBy!: string | null;
  createdAt!: string;
}

// ── Leave ────────────────────────────────────────────────────────────────────
export const CreateLeaveSchema = z
  .object({
    leaveType: z.enum(leaveTypeEnum.enumValues),
    startDate: dateStr,
    endDate: dateStr,
    /**
     * Which part of the first and last day the window covers. Both default to `full_day`, so a
     * caller that ignores them books whole days exactly as it always did.
     *
     * The combinations that have no meaning — morning-to-afternoon for a whole day, a multi-day
     * window starting with a lone morning — are refused by the service with
     * `LEAVE_INVALID_WINDOW`, not here: they are also CHECKs on the table, and a rule stated in
     * three places is a rule that will disagree with itself. Zod's job is the vocabulary.
     */
    startPortion: z.enum(leaveDayPortionEnum.enumValues).optional(),
    endPortion: z.enum(leaveDayPortionEnum.enumValues).optional(),
    reason: z.string().max(1000).optional(),
  })
  .refine((v) => v.startDate <= v.endDate, {
    message: 'startDate must be on or before endDate',
    path: ['endDate'],
  });
export class CreateLeaveDto extends createZodDto(CreateLeaveSchema) {}

export const ListLeaveQuerySchema = z
  .object({
    employeeId: z.string().uuid().optional(),
    status: z.enum(leaveStatusEnum.enumValues).optional(),
    /**
     * Inclusive bounds on `startDate` — requests whose window BEGINS in the range, the same column
     * the list is ordered by. Not an overlap test: a window straddling the range boundary is not
     * matched (that is `overlappingLeaveCandidates`' job, not a list filter's).
     */
    dateFrom: dateStr.optional(),
    dateTo: dateStr.optional(),
  })
  .merge(PaginationQuerySchema)
  .refine((v) => !v.dateFrom || !v.dateTo || v.dateFrom <= v.dateTo, {
    message: 'dateFrom must be on or before dateTo',
    path: ['dateTo'],
  });
export class ListLeaveQueryDto extends createZodDto(ListLeaveQuerySchema) {}

export class LeaveResponseDto {
  id!: string;
  employeeId!: string;
  @ApiProperty({ enum: leaveTypeEnum.enumValues })
  leaveType!: (typeof leaveTypeEnum.enumValues)[number];
  startDate!: string;
  endDate!: string;
  /**
   * Which part of the first and last day the window covers: `full_day`, `morning` or `afternoon`.
   *
   * Always present — a whole-day request reads `full_day` at both ends — so a client never has to
   * treat an absent portion as a special case.
   */
  @ApiProperty({ enum: leaveDayPortionEnum.enumValues })
  startPortion!: (typeof leaveDayPortionEnum.enumValues)[number];
  @ApiProperty({ enum: leaveDayPortionEnum.enumValues })
  endPortion!: (typeof leaveDayPortionEnum.enumValues)[number];
  reason!: string | null;
  /**
   * Working days this request costs, excluding weekends, public holidays and part-day ends, frozen
   * at submit. Half days are real values here: an afternoon off is `0.5`.
   *
   * `null` only for rows predating the column. Surfaced because an approver deciding a request
   * needs to know what it takes out of the balance — the number is useless if only the server
   * can see it.
   */
  workingDays!: number | null;
  @ApiProperty({ enum: leaveStatusEnum.enumValues })
  status!: (typeof leaveStatusEnum.enumValues)[number];
  reviewerId!: string | null;
  reviewedAt!: string | null;
  createdAt!: string;
}

// ── Overtime ─────────────────────────────────────────────────────────────────
export const CreateOvertimeSchema = z.object({
  workDate: dateStr,
  hours: z.number().min(0.25).max(24),
  reason: z.string().min(1).max(1000),
});
export class CreateOvertimeDto extends createZodDto(CreateOvertimeSchema) {}

export const ListOvertimeQuerySchema = z
  .object({
    employeeId: z.string().uuid().optional(),
    status: z.enum(overtimeStatusEnum.enumValues).optional(),
    /** Inclusive lower and upper bounds on `workDate` — "this pay period", not "this instant". */
    dateFrom: dateStr.optional(),
    dateTo: dateStr.optional(),
  })
  .merge(PaginationQuerySchema)
  .refine((v) => !v.dateFrom || !v.dateTo || v.dateFrom <= v.dateTo, {
    message: 'dateFrom must be on or before dateTo',
    path: ['dateTo'],
  });
export class ListOvertimeQueryDto extends createZodDto(ListOvertimeQuerySchema) {}

export class OvertimeResponseDto {
  id!: string;
  employeeId!: string;
  workDate!: string;
  hours!: string;
  reason!: string;
  @ApiProperty({ enum: overtimeStatusEnum.enumValues })
  status!: (typeof overtimeStatusEnum.enumValues)[number];
  reviewerId!: string | null;
  reviewedAt!: string | null;
  createdAt!: string;
}

// ── Shift logs ───────────────────────────────────────────────────────────────
export const CreateShiftLogSchema = z
  .object({
    shiftType: z.enum(shiftTypeEnum.enumValues),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    note: z.string().max(500).optional(),
  })
  .refine((v) => v.startsAt < v.endsAt, {
    message: 'startsAt must be before endsAt',
    path: ['endsAt'],
  });
export class CreateShiftLogDto extends createZodDto(CreateShiftLogSchema) {}

export const ListShiftLogsQuerySchema = z
  .object({
    employeeId: z.string().uuid().optional(),
    shiftType: z.enum(shiftTypeEnum.enumValues).optional(),
  })
  .merge(PaginationQuerySchema);
export class ListShiftLogsQueryDto extends createZodDto(ListShiftLogsQuerySchema) {}

export class ShiftLogResponseDto {
  id!: string;
  employeeId!: string;
  @ApiProperty({ enum: shiftTypeEnum.enumValues })
  shiftType!: (typeof shiftTypeEnum.enumValues)[number];
  startsAt!: string;
  endsAt!: string;
  note!: string | null;
  createdAt!: string;
}

// ── Review ───────────────────────────────────────────────────────────────────
export const ReviewSchema = z.object({ approve: z.boolean() });
export class ReviewDto extends createZodDto(ReviewSchema) {}

// ── Onboarding ───────────────────────────────────────────────────────────────
export const SubmitOnboardingSchema = z.object({
  /** UUID of the employee being onboarded. */
  employeeId: z.string().uuid(),
  /** Planned start date (YYYY-MM-DD). */
  startDate: dateStr,
  department: z.string().max(120).optional(),
  jobTitle: z.string().max(120).optional(),
  /** Display name of the direct manager (informational, for IT provisioning context). */
  managerName: z.string().max(120).optional(),
  /** Requested device form-factor: laptop | desktop | remote_only | byod */
  equipmentType: z.enum(['laptop', 'desktop', 'remote_only', 'byod']).optional(),
  /** Preferred OS: windows | macos | linux */
  preferredOs: z.enum(['windows', 'macos', 'linux']).optional(),
  /** Free-text equipment notes for IT (peripherals, special requirements, etc.). */
  equipmentNote: z.string().max(500).optional(),
  /** Systems / apps the new hire needs access to on day one. */
  accessNeeds: z.array(z.string().max(80)).max(20).optional(),
});
export class SubmitOnboardingDto extends createZodDto(SubmitOnboardingSchema) {}

export class OnboardingResponseDto {
  /** Engine request ID — use this to track approval progress. */
  requestId!: string;
}

// ── Offboarding ───────────────────────────────────────────────────────────────
export const SubmitOffboardingSchema = z.object({
  /** UUID of the employee being offboarded. */
  employeeId: z.string().uuid(),
  /** Optional reason / business justification. */
  reason: z.string().max(1000).optional(),
});
export class SubmitOffboardingDto extends createZodDto(SubmitOffboardingSchema) {}

export class OffboardingResponseDto {
  /** Engine request ID — use this to track approval progress. */
  requestId!: string;
}

export const PresignLeaveDocumentSchema = z.object({
  fileName: z.string().min(1).max(255),
  mimeType: z.enum(['application/pdf', 'image/jpeg', 'image/png']),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(10 * 1024 * 1024),
});
export class PresignLeaveDocumentDto extends createZodDto(PresignLeaveDocumentSchema) {}

export const ConfirmLeaveDocumentSchema = z.object({
  fileId: z.string().uuid(),
});
export class ConfirmLeaveDocumentDto extends createZodDto(ConfirmLeaveDocumentSchema) {}

// ── Leave entitlement, balances and the holiday calendar ─────────────────────

/**
 * `year` is optional and defaults to the CURRENT year in the controller rather than here: a
 * default baked into the schema would be evaluated when the module loads, so a process running
 * across New Year would keep serving last year's balances until it restarted.
 */
export const LeaveBalanceQuerySchema = z.object({
  employeeId: z.string().uuid().optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});
export class LeaveBalanceQueryDto extends createZodDto(LeaveBalanceQuerySchema) {}

export class LeaveBalanceResponseDto {
  @ApiProperty({ enum: leaveTypeEnum.enumValues })
  leaveType!: (typeof leaveTypeEnum.enumValues)[number];
  year!: number;
  /** The year's whole entitlement, as HR set it. */
  grantedDays!: number;
  /** How much of it has been EARNED so far — equal to `grantedDays` unless accrual is monthly. */
  accruedDays!: number;
  carriedOverDays!: number;
  /** When carried days lapse, or null when they do not. */
  carriedOverExpiresOn!: string | null;
  /** Whether those carried days still count today. */
  carriedOverAvailable!: boolean;
  /** Working days already committed — approved AND still-pending requests. */
  consumedDays!: number;
  /**
   * What may be booked RIGHT NOW: `accrued + carried (if unexpired) − consumed`.
   *
   * This is the figure the balance check enforces, and it is smaller than `remainingDays` whenever
   * the year is part-accrued or carried days have lapsed.
   */
  availableDays!: number;
  /** What the year will settle at: `granted + carried − consumed`, ignoring accrual and expiry. */
  remainingDays!: number;
}

export class LeavePolicyResponseDto {
  @ApiProperty({ enum: leaveTypeEnum.enumValues })
  leaveType!: (typeof leaveTypeEnum.enumValues)[number];
  /** `annual_grant` — available in full from 1 January — or `monthly_accrual`. */
  accrualMethod!: string;
  carryOverMaxDays!: number;
  /** Months into the new year that carried days survive, or null when they never lapse. */
  carryOverExpiryMonths!: number | null;
  note!: string | null;
  /**
   * True when this type has NO policy row and is running on the default.
   *
   * The default is `annual_grant` with no carry-over, which is how every entitlement behaved before
   * accrual existed — so a reader can tell "nobody has decided" from "somebody decided this".
   */
  isDefault!: boolean;
}

export const RunCarryOverSchema = z.object({
  /** The year to bring days INTO. Days come from `year - 1`. */
  year: z.coerce.number().int().min(2000).max(2100),
});
export class RunCarryOverDto extends createZodDto(RunCarryOverSchema) {}

export class CarryOverResultResponseDto {
  applied!: { employeeId: string; leaveType: string; days: number; expiresOn: string | null }[];
  /**
   * Employees whose previous year had days to carry but who have no entitlement row for the target
   * year yet.
   *
   * Reported rather than invented: the new year's grant is HR's decision, and a row created here with
   * a zero grant would read as an entitlement of nothing.
   */
  skippedNoTargetRow!: { employeeId: string; leaveType: string; days: number }[];
}

export const SetLeaveEntitlementSchema = z.object({
  employeeId: z.string().uuid(),
  leaveType: z.enum(leaveTypeEnum.enumValues),
  year: z.coerce.number().int().min(2000).max(2100),
  // Half-days are real, so this is not an integer. Capped well below a year's working days.
  grantedDays: z.number().min(0).max(365),
  carriedOverDays: z.number().min(0).max(365).optional(),
  note: z.string().max(500).optional(),
});
export class SetLeaveEntitlementDto extends createZodDto(SetLeaveEntitlementSchema) {}

export const HolidayQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});
export class HolidayQueryDto extends createZodDto(HolidayQuerySchema) {}

export const CreateHolidaySchema = z.object({
  date: z.string().date(),
  name: z.string().min(1).max(160),
  /** 'ALL' for a national holiday; a region code narrows it. */
  region: z.string().min(1).max(32).optional(),
});
export class CreateHolidayDto extends createZodDto(CreateHolidaySchema) {}

export class HolidayResponseDto {
  id!: string;
  date!: string;
  name!: string;
  region!: string;
}
