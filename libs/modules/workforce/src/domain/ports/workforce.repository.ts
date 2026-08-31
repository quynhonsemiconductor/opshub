import type { DbExecutor } from '@platform';
import type {
  CreateLeaveInput,
  CreateOvertimeInput,
  CreateShiftLogInput,
  CreateTimesheetInput,
  LeaveFilters,
  LeaveRequest,
  LeaveStatus,
  OvertimeEntry,
  OvertimeFilters,
  OvertimeStatus,
  ShiftLog,
  ShiftLogFilters,
  Timesheet,
  TimesheetFilters,
  TimesheetStatus,
} from '../workforce.types';
import type { LeaveWindow } from '../leave-window';

export const WORKFORCE_REPOSITORY = Symbol('WORKFORCE_REPOSITORY');

export interface IWorkforceRepository {
  // Timesheets
  createTimesheet(input: CreateTimesheetInput): Promise<Timesheet>;
  /**
   * Every entry in ONE insert. Runs inside `tx` when the caller passed one — the service does,
   * so the audit trail for the batch commits in the SAME transaction as the rows — and opens its
   * own otherwise. Either way, all rows land or none do.
   */
  createTimesheets(inputs: CreateTimesheetInput[], tx?: DbExecutor): Promise<Timesheet[]>;
  findTimesheetById(id: string): Promise<Timesheet | null>;
  listTimesheets(
    filters: TimesheetFilters,
    limit: number,
    offset: number,
  ): Promise<{ rows: Timesheet[]; total: number }>;
  setTimesheetStatus(
    id: string,
    status: TimesheetStatus,
    approvedBy: string | null,
    tx?: DbExecutor,
  ): Promise<Timesheet | null>;

  // Leave
  createLeave(input: CreateLeaveInput): Promise<LeaveRequest>;
  findLeaveById(id: string): Promise<LeaveRequest | null>;
  listLeave(
    filters: LeaveFilters,
    limit: number,
    offset: number,
  ): Promise<{ rows: LeaveRequest[]; total: number }>;
  setLeaveStatus(
    id: string,
    status: LeaveStatus,
    reviewerId: string | null,
    tx?: DbExecutor,
  ): Promise<LeaveRequest | null>;
  /** Backlink the engine request_items id into the domain row. */
  setLeaveRequestId(id: string, requestId: string, tx?: DbExecutor): Promise<void>;
  /** Update the S3 object key for the leave supporting document. Pass null to clear. */
  updateLeaveDocument(
    id: string,
    documentStorageKey: string | null,
    tx?: DbExecutor,
  ): Promise<void>;
  /**
   * Live requests whose DATE RANGE touches this one — candidates for an overlap, not a verdict.
   *
   * The range test cannot produce a false negative, so it is the right thing to push into SQL
   * where an index serves it. It CAN produce a false positive now that leave is part-day: a
   * morning and an afternoon on the same date share a range and no time. `leaveWindowsOverlap`
   * decides the rows this returns, which keeps the portion vocabulary interpreted in exactly one
   * place.
   */
  overlappingLeaveCandidates(
    employeeId: string,
    startDate: string,
    endDate: string,
  ): Promise<LeaveWindow[]>;

  // Overtime
  createOvertime(input: CreateOvertimeInput): Promise<OvertimeEntry>;
  findOvertimeById(id: string): Promise<OvertimeEntry | null>;
  listOvertime(
    filters: OvertimeFilters,
    limit: number,
    offset: number,
  ): Promise<{ rows: OvertimeEntry[]; total: number }>;
  setOvertimeStatus(
    id: string,
    status: OvertimeStatus,
    reviewerId: string | null,
    tx?: DbExecutor,
  ): Promise<OvertimeEntry | null>;
  /** Backlink the engine request_items id into the domain row. */
  setOvertimeRequestId(id: string, requestId: string): Promise<void>;

  // Shift logs
  createShiftLog(input: CreateShiftLogInput): Promise<ShiftLog>;
  findShiftLogById(id: string): Promise<ShiftLog | null>;
  listShiftLogs(
    filters: ShiftLogFilters,
    limit: number,
    offset: number,
  ): Promise<{ rows: ShiftLog[]; total: number }>;
}
