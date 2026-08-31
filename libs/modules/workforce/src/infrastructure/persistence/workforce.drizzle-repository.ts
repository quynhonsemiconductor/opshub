import { Injectable } from '@nestjs/common';
import { and, desc, eq, lte, gte, sql } from 'drizzle-orm';
import { InjectDrizzle, type DrizzleDB, type DbExecutor } from '@platform';
import { newId } from '@shared-kernel';
import { timesheets, leaveRequests, overtimeEntries, shiftLogs } from '../../../../../../db/schema';
import type { IWorkforceRepository } from '../../domain/ports/workforce.repository';
import type { LeaveWindow } from '../../domain/leave-window';
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
} from '../../domain/workforce.types';

@Injectable()
export class WorkforceDrizzleRepository implements IWorkforceRepository {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  // ── Timesheets ─────────────────────────────────────────────────────────────
  async createTimesheet(input: CreateTimesheetInput): Promise<Timesheet> {
    const [row] = await this.db
      .insert(timesheets)
      .values({
        id: newId(),
        employeeId: input.employeeId,
        workDate: input.workDate,
        minutesWorked: input.minutesWorked,
        note: input.note ?? null,
      })
      .returning();
    return row;
  }

  async createTimesheets(inputs: CreateTimesheetInput[]): Promise<Timesheet[]> {
    // ONE multi-row insert inside a transaction — a partial batch is not a state this method can
    // reach: any failure rolls every row back together. The explicit transaction is redundant for
    // a single statement but keeps the all-or-nothing promise true if a second write ever joins
    // it, and the bulk endpoint is written against that promise.
    return this.db.transaction(async (tx) =>
      tx
        .insert(timesheets)
        .values(
          inputs.map((input) => ({
            id: newId(),
            employeeId: input.employeeId,
            workDate: input.workDate,
            minutesWorked: input.minutesWorked,
            note: input.note ?? null,
          })),
        )
        .returning(),
    );
  }

  async findTimesheetById(id: string): Promise<Timesheet | null> {
    const [row] = await this.db.select().from(timesheets).where(eq(timesheets.id, id)).limit(1);
    return row ?? null;
  }

  async listTimesheets(
    filters: TimesheetFilters,
    limit: number,
    offset: number,
  ): Promise<{ rows: Timesheet[]; total: number }> {
    const conditions = [
      filters.employeeId ? eq(timesheets.employeeId, filters.employeeId) : undefined,
      filters.status ? eq(timesheets.status, filters.status) : undefined,
      // Inclusive bounds on workDate — the same condition shape the leave overlap query uses.
      filters.dateFrom ? gte(timesheets.workDate, filters.dateFrom) : undefined,
      filters.dateTo ? lte(timesheets.workDate, filters.dateTo) : undefined,
    ].filter(Boolean);
    const where = conditions.length ? and(...conditions) : undefined;

    const rows = await this.db
      .select()
      .from(timesheets)
      .where(where)
      .orderBy(desc(timesheets.workDate), desc(timesheets.id))
      .limit(limit)
      .offset(offset);
    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(timesheets)
      .where(where);
    return { rows: rows, total: count };
  }

  async setTimesheetStatus(
    id: string,
    status: TimesheetStatus,
    approvedBy: string | null,
    tx?: DbExecutor,
  ): Promise<Timesheet | null> {
    const [row] = await (tx ?? this.db)
      .update(timesheets)
      .set({
        status,
        approvedBy: status === 'approved' ? approvedBy : null,
        submittedAt: status === 'submitted' ? new Date() : undefined,
        updatedAt: new Date(),
      })
      .where(eq(timesheets.id, id))
      .returning();
    return row ?? null;
  }

  // ── Leave ──────────────────────────────────────────────────────────────────
  async createLeave(input: CreateLeaveInput): Promise<LeaveRequest> {
    const [row] = await this.db
      .insert(leaveRequests)
      .values({
        id: newId(),
        employeeId: input.employeeId,
        leaveType: input.leaveType,
        startDate: input.startDate,
        endDate: input.endDate,
        // Omitted rather than defaulted to 'full_day' here: the column's DEFAULT is the one place
        // that decision belongs, and a second copy of it would be the one that drifts.
        startPortion: input.startPortion,
        endPortion: input.endPortion,
        // Stored as a string: numeric(5,2) round-trips through the driver as text, and letting a
        // JS number through here would silently become '3' vs '3.00' depending on the value.
        workingDays: input.workingDays === undefined ? null : String(input.workingDays),
        reason: input.reason ?? null,
        requestId: input.requestId ?? null,
      })
      .returning();
    return row;
  }

  async findLeaveById(id: string): Promise<LeaveRequest | null> {
    const [row] = await this.db
      .select()
      .from(leaveRequests)
      .where(eq(leaveRequests.id, id))
      .limit(1);
    return row ?? null;
  }

  async listLeave(
    filters: LeaveFilters,
    limit: number,
    offset: number,
  ): Promise<{ rows: LeaveRequest[]; total: number }> {
    const conditions = [
      filters.employeeId ? eq(leaveRequests.employeeId, filters.employeeId) : undefined,
      filters.status ? eq(leaveRequests.status, filters.status) : undefined,
      // Inclusive bounds on startDate — the day the window begins, the column the list is ordered
      // by and the index serves, and the same condition shape listTimesheets uses on workDate.
      filters.dateFrom ? gte(leaveRequests.startDate, filters.dateFrom) : undefined,
      filters.dateTo ? lte(leaveRequests.startDate, filters.dateTo) : undefined,
    ].filter(Boolean);
    const where = conditions.length ? and(...conditions) : undefined;

    const rows = await this.db
      .select()
      .from(leaveRequests)
      .where(where)
      .orderBy(desc(leaveRequests.startDate), desc(leaveRequests.id))
      .limit(limit)
      .offset(offset);
    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(leaveRequests)
      .where(where);
    return { rows: rows, total: count };
  }

  async setLeaveStatus(
    id: string,
    status: LeaveStatus,
    reviewerId: string | null,
    tx?: DbExecutor,
  ): Promise<LeaveRequest | null> {
    const reviewed = status === 'approved' || status === 'rejected';
    const [row] = await (tx ?? this.db)
      .update(leaveRequests)
      .set({
        status,
        reviewerId: reviewed ? reviewerId : null,
        reviewedAt: reviewed ? new Date() : null,
      })
      .where(eq(leaveRequests.id, id))
      .returning();
    return row ?? null;
  }

  async setLeaveRequestId(id: string, requestId: string, tx?: DbExecutor): Promise<void> {
    await (tx ?? this.db).update(leaveRequests).set({ requestId }).where(eq(leaveRequests.id, id));
  }

  async updateLeaveDocument(
    id: string,
    documentStorageKey: string | null,
    tx?: DbExecutor,
  ): Promise<void> {
    await (tx ?? this.db)
      .update(leaveRequests)
      .set({ documentStorageKey })
      .where(eq(leaveRequests.id, id));
  }

  async overlappingLeaveCandidates(
    employeeId: string,
    startDate: string,
    endDate: string,
  ): Promise<LeaveWindow[]> {
    return this.db
      .select({
        startDate: leaveRequests.startDate,
        endDate: leaveRequests.endDate,
        startPortion: leaveRequests.startPortion,
        endPortion: leaveRequests.endPortion,
      })
      .from(leaveRequests)
      .where(
        and(
          eq(leaveRequests.employeeId, employeeId),
          // Only live requests hold a date: a rejected or cancelled one released it.
          sql`${leaveRequests.status} in ('pending','approved')`,
          lte(leaveRequests.startDate, endDate),
          gte(leaveRequests.endDate, startDate),
        ),
      );
  }

  // ── Overtime ───────────────────────────────────────────────────────────────
  async createOvertime(input: CreateOvertimeInput): Promise<OvertimeEntry> {
    const [row] = await this.db
      .insert(overtimeEntries)
      .values({
        id: newId(),
        employeeId: input.employeeId,
        workDate: input.workDate,
        hours: String(input.hours),
        reason: input.reason,
        requestId: input.requestId ?? null,
      })
      .returning();
    return row;
  }

  async findOvertimeById(id: string): Promise<OvertimeEntry | null> {
    const [row] = await this.db
      .select()
      .from(overtimeEntries)
      .where(eq(overtimeEntries.id, id))
      .limit(1);
    return row ?? null;
  }

  async listOvertime(
    filters: OvertimeFilters,
    limit: number,
    offset: number,
  ): Promise<{ rows: OvertimeEntry[]; total: number }> {
    const conditions = [
      filters.employeeId ? eq(overtimeEntries.employeeId, filters.employeeId) : undefined,
      filters.status ? eq(overtimeEntries.status, filters.status) : undefined,
      // Inclusive bounds on workDate — the same condition shape listTimesheets uses.
      filters.dateFrom ? gte(overtimeEntries.workDate, filters.dateFrom) : undefined,
      filters.dateTo ? lte(overtimeEntries.workDate, filters.dateTo) : undefined,
    ].filter(Boolean);
    const where = conditions.length ? and(...conditions) : undefined;

    const rows = await this.db
      .select()
      .from(overtimeEntries)
      .where(where)
      .orderBy(desc(overtimeEntries.workDate), desc(overtimeEntries.id))
      .limit(limit)
      .offset(offset);
    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(overtimeEntries)
      .where(where);
    return { rows: rows, total: count };
  }

  async setOvertimeStatus(
    id: string,
    status: OvertimeStatus,
    reviewerId: string | null,
    tx?: DbExecutor,
  ): Promise<OvertimeEntry | null> {
    const reviewed = status === 'approved' || status === 'rejected';
    const [row] = await (tx ?? this.db)
      .update(overtimeEntries)
      .set({
        status,
        reviewerId: reviewed ? reviewerId : null,
        reviewedAt: reviewed ? new Date() : null,
      })
      .where(eq(overtimeEntries.id, id))
      .returning();
    return row ?? null;
  }

  async setOvertimeRequestId(id: string, requestId: string): Promise<void> {
    await this.db.update(overtimeEntries).set({ requestId }).where(eq(overtimeEntries.id, id));
  }

  // ── Shift logs ─────────────────────────────────────────────────────────────
  async createShiftLog(input: CreateShiftLogInput): Promise<ShiftLog> {
    const [row] = await this.db
      .insert(shiftLogs)
      .values({
        id: newId(),
        employeeId: input.employeeId,
        shiftType: input.shiftType,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        note: input.note ?? null,
      })
      .returning();
    return row;
  }

  async findShiftLogById(id: string): Promise<ShiftLog | null> {
    const [row] = await this.db.select().from(shiftLogs).where(eq(shiftLogs.id, id)).limit(1);
    return row ?? null;
  }

  async listShiftLogs(
    filters: ShiftLogFilters,
    limit: number,
    offset: number,
  ): Promise<{ rows: ShiftLog[]; total: number }> {
    const conditions = [
      filters.employeeId ? eq(shiftLogs.employeeId, filters.employeeId) : undefined,
      filters.shiftType ? eq(shiftLogs.shiftType, filters.shiftType) : undefined,
    ].filter(Boolean);
    const where = conditions.length ? and(...conditions) : undefined;

    const rows = await this.db
      .select()
      .from(shiftLogs)
      .where(where)
      .orderBy(desc(shiftLogs.startsAt), desc(shiftLogs.id))
      .limit(limit)
      .offset(offset);
    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(shiftLogs)
      .where(where);
    return { rows: rows, total: count };
  }
}
