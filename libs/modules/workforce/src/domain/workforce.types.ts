import type {
  leaveAccrualMethodEnum,
  leaveDayPortionEnum,
  leaveStatusEnum,
  leaveTypeEnum,
  overtimeStatusEnum,
  shiftTypeEnum,
  timesheetStatusEnum,
} from '../../../../../db/schema';

export type TimesheetStatus = (typeof timesheetStatusEnum.enumValues)[number];
export type LeaveType = (typeof leaveTypeEnum.enumValues)[number];
/** How a year's granted days become available — see `workforce.leave_policies`. */
export type LeaveAccrualMethod = (typeof leaveAccrualMethodEnum.enumValues)[number];
export type LeaveStatus = (typeof leaveStatusEnum.enumValues)[number];
/** Which part of a day a leave window's boundary falls on — see `domain/leave-window.ts`. */
export type LeaveDayPortion = (typeof leaveDayPortionEnum.enumValues)[number];
export type OvertimeStatus = (typeof overtimeStatusEnum.enumValues)[number];
export type ShiftType = (typeof shiftTypeEnum.enumValues)[number];

// ── Timesheets ───────────────────────────────────────────────────────────────
export interface Timesheet {
  id: string;
  employeeId: string;
  workDate: string;
  minutesWorked: number;
  note: string | null;
  status: TimesheetStatus;
  submittedAt: Date | null;
  approvedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateTimesheetInput {
  employeeId: string;
  workDate: string;
  minutesWorked: number;
  note?: string | null;
}

export interface TimesheetFilters {
  employeeId?: string;
  status?: TimesheetStatus;
  /** Inclusive lower and upper bounds on `workDate`, as YYYY-MM-DD. */
  dateFrom?: string;
  dateTo?: string;
}

// ── Leave ────────────────────────────────────────────────────────────────────
export interface LeaveRequest {
  id: string;
  employeeId: string;
  leaveType: LeaveType;
  startDate: string;
  endDate: string;
  startPortion: LeaveDayPortion;
  endPortion: LeaveDayPortion;
  reason: string | null;
  /**
   * Working days the window costs, frozen at submit. `numeric(5,2)`, so the driver hands it back
   * as a STRING — the DTO converts. `null` only for rows predating the column.
   */
  workingDays: string | null;
  /** S3 key for a supporting document (e.g. medical cert). Null until uploaded. */
  documentStorageKey: string | null;
  status: LeaveStatus;
  reviewerId: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
  /** Link to the universal request engine (null for legacy rows). */
  requestId: string | null;
}

export interface CreateLeaveInput {
  employeeId: string;
  leaveType: LeaveType;
  startDate: string;
  endDate: string;
  /** Defaults to `full_day` at both ends, which is how every request behaved before 0028. */
  startPortion?: LeaveDayPortion;
  endPortion?: LeaveDayPortion;
  /** Working days the window costs, frozen at submit — see the column's docblock. */
  workingDays?: number;
  reason?: string | null;
  requestId?: string | null;
}

export interface LeaveFilters {
  employeeId?: string;
  status?: LeaveStatus;
  /** Inclusive lower and upper bounds on `startDate`, as YYYY-MM-DD — window BEGINS in range. */
  dateFrom?: string;
  dateTo?: string;
}

// ── Overtime ─────────────────────────────────────────────────────────────────
export interface OvertimeEntry {
  id: string;
  employeeId: string;
  workDate: string;
  hours: string;
  reason: string;
  status: OvertimeStatus;
  reviewerId: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
  /** Link to the universal request engine (null for legacy rows). */
  requestId: string | null;
}

export interface CreateOvertimeInput {
  employeeId: string;
  workDate: string;
  hours: number;
  reason: string;
  requestId?: string | null;
}

export interface OvertimeFilters {
  employeeId?: string;
  status?: OvertimeStatus;
  /** Inclusive lower and upper bounds on `workDate`, as YYYY-MM-DD. */
  dateFrom?: string;
  dateTo?: string;
}

// ── Shift logs ───────────────────────────────────────────────────────────────
export interface ShiftLog {
  id: string;
  employeeId: string;
  shiftType: ShiftType;
  startsAt: Date;
  endsAt: Date;
  note: string | null;
  createdAt: Date;
}

export interface CreateShiftLogInput {
  employeeId: string;
  shiftType: ShiftType;
  startsAt: Date;
  endsAt: Date;
  note?: string | null;
}

export interface ShiftLogFilters {
  employeeId?: string;
  shiftType?: ShiftType;
}
