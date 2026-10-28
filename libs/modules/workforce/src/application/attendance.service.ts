import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gte, inArray, lt, lte, ne, sql } from 'drizzle-orm';
import {
  AuthzService,
  ErrorCodes,
  InjectDrizzle,
  NotFoundException,
  PermissionDeniedException,
  PreconditionFailedException,
  RequestEngine,
  ActorScope,
  ConflictException,
  type DrizzleDB,
} from '@platform';
import {
  AuditService,
  AUDIT_ACTION,
  AUDIT_RESOURCE,
  type ResourceAuditTrail,
} from '@modules/audit';
import { MS_PER_HOUR, REPORT_ROW_LIMIT, type Actor } from '@shared-kernel';
import {
  attendanceJustifications,
  attendanceMonthCloses,
  employees,
  holidays,
  leaveRequests,
  wfhRequests,
} from '../../../../../db/schema';
import { cards as doorCards, events as doorEvents } from '../../../../../db/schema/door';
import { computeAttendanceDay, type AttendanceDay, type DayFlag, type LeavePortion } from '../domain/attendance-day';
import { lastDayOf } from '../domain/wio-day';
import { portionOn, type PtoWindow } from '../domain/wio-pto';
import { workingDatesInRange } from '../domain/working-days';
import { WORKFORCE_REPOSITORY, type IWorkforceRepository } from '../domain/ports/workforce.repository';
import type { AttendanceJustificationPayload } from './attendance-justification.type-def';

/** A month is closed when a row exists. The row IS the lock. */
export interface MonthClose {
  month: string;
  closedBy: string;
  closedAt: Date;
  note: string | null;
}

export interface EmployeeAttendanceMonth {
  id: string;
  name: string;
  department: string | null;
  days: (AttendanceDay & { pendingJustification: boolean })[];
}

export interface AttendanceMonth {
  month: string;
  close: MonthClose | null;
  employees: EmployeeAttendanceMonth[];
}

/**
 * Asia/Ho_Chi_Minh as a fixed UTC+7 offset. The zone has had no DST since 1975 and none is
 * scheduled, so the offset IS the zone — and stating it here keeps the day boundary arithmetic
 * (which minute belongs to which local day) in SQL, in one place, instead of spread through JS
 * `Date` parsing that mixes frames. Every door event time below is converted in the query with
 * `AT TIME ZONE 'Asia/Ho_Chi_Minh'`, the same string.
 */
const HCM_UTC_OFFSET = '+07:00';

/** `[month-01 00:00 HCM, next-month-01 00:00 HCM)` as instants — the window a month's events fall in. */
function monthInstantBounds(month: string): [Date, Date] {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return [
    new Date(`${month}-01T00:00:00${HCM_UTC_OFFSET}`),
    new Date(`${y}-${String(m + 1).padStart(2, '0')}-01T00:00:00${HCM_UTC_OFFSET}`),
  ];
}

/** The months the closed range `[startDate, endDate]` falls into. */
export function monthsOfRange(startDate: string, endDate: string): string[] {
  const months = new Set<string>();
  for (const date of [startDate, endDate]) months.add(date.slice(0, 7));
  // A window can span more than its two endpoints' months only through those endpoints, because a
  // date range is continuous: the set of first-of-months between them is what a close key would hit.
  let [y, m] = startDate.split('-').map(Number) as [number, number];
  const [ey, em] = endDate.split('-').map(Number) as [number, number];
  while (y < ey || (y === ey && m <= em)) {
    months.add(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) {
      y += 1;
      m = 1;
    }
  }
  return [...months].sort();
}

/**
 * Attendance: the derived month view, the justification request flow, and the month close.
 *
 * NOTHING PER DAY IS STORED. A day's status, worked minutes and flags are computed at read time
 * from the door swipes (read-only — this module never writes to the door schema) plus the live
 * leave, WFH and justification requests, per `domain/attendance-day.ts`, which is the spec.
 *
 * WHO SEES WHOM. `workforce.attendance.read` (hr, auditor; admin by wildcard) sees everybody. A
 * manager without it sees THEMSELF and their DIRECT REPORTS. An employee sees themself through
 * `/me`. Asking for someone outside your scope is a 403, not an empty month.
 */
@Injectable()
export class AttendanceService {
  private readonly justificationTrail: ResourceAuditTrail;
  private readonly monthTrail: ResourceAuditTrail;

  constructor(
    @Inject(WORKFORCE_REPOSITORY) private readonly repo: IWorkforceRepository,
    audit: AuditService,
    private readonly engine: RequestEngine,
    private readonly authz: AuthzService,
    private readonly actorScope: ActorScope,
    @InjectDrizzle() private readonly db: DrizzleDB,
  ) {
    this.justificationTrail = audit.forResource(AUDIT_RESOURCE.ATTENDANCE_JUSTIFICATION);
    this.monthTrail = audit.forResource(AUDIT_RESOURCE.ATTENDANCE_MONTH);
  }

  // ── Scope ──────────────────────────────────────────────────────────────────

  /**
   * The employees whose attendance `actor` may read for `month`: everybody for a global
   * `workforce.attendance.read` holder, self + direct reports for anyone else. An explicit
   * `employeeId` outside that set is DENIED rather than quietly narrowed.
   */
  private async scopedEmployees(actor: Actor, employeeId?: string): Promise<{ id: string; name: string; department: string | null }[]> {
    const readsAll = await this.authz.check(actor.sub, 'workforce.attendance.read');
    if (readsAll) {
      const rows = await this.db
        .select({ id: employees.id, name: employees.displayName, department: employees.department })
        .from(employees)
        .where(ne(employees.status, 'offboarded'))
        .orderBy(asc(employees.displayName), asc(employees.id));
      return employeeId ? rows.filter((r) => r.id === employeeId) : rows;
    }
    const team = await this.db
      .select({ id: employees.id, name: employees.displayName, department: employees.department })
      .from(employees)
      .where(and(eq(employees.managerId, actor.sub), ne(employees.status, 'offboarded')));
    const mine = await this.db
      .select({ id: employees.id, name: employees.displayName, department: employees.department })
      .from(employees)
      .where(eq(employees.id, actor.sub));
    const allowed = [...mine, ...team];
    if (employeeId && !allowed.some((e) => e.id === employeeId)) {
      throw new PermissionDeniedException(
        'Missing permission: workforce.attendance.read — that employee is not you or your direct report',
      );
    }
    return employeeId ? allowed.filter((e) => e.id === employeeId) : allowed;
  }

  // ── The derived month ───────────────────────────────────────────────────────

  async getMonth(month: string, actor: Actor, employeeId?: string): Promise<AttendanceMonth> {
    const people = await this.scopedEmployees(actor, employeeId);
    const from = `${month}-01`;
    const to = lastDayOf(month);
    const [monthStart, monthEnd] = monthInstantBounds(month);

    const [monthHolidays, leaveWindows, wfhWindows, justifications, swipes] = await Promise.all([
      this.db
        .select({ date: holidays.date })
        .from(holidays)
        .where(and(gte(holidays.date, from), lte(holidays.date, to))),
      this.db
        .select({
          employeeId: leaveRequests.employeeId,
          startDate: leaveRequests.startDate,
          endDate: leaveRequests.endDate,
          startPortion: leaveRequests.startPortion,
          endPortion: leaveRequests.endPortion,
        })
        .from(leaveRequests)
        .where(
          and(
            eq(leaveRequests.status, 'approved'),
            lte(leaveRequests.startDate, to),
            gte(leaveRequests.endDate, from),
          ),
        ),
      this.db
        .select({
          employeeId: wfhRequests.employeeId,
          startDate: wfhRequests.startDate,
          endDate: wfhRequests.endDate,
        })
        .from(wfhRequests)
        .where(
          and(
            eq(wfhRequests.status, 'approved'),
            lte(wfhRequests.startDate, to),
            gte(wfhRequests.endDate, from),
          ),
        ),
      this.db
        .select({
          employeeId: attendanceJustifications.employeeId,
          startDate: attendanceJustifications.startDate,
          endDate: attendanceJustifications.endDate,
          status: attendanceJustifications.status,
        })
        .from(attendanceJustifications)
        .where(
          and(
            sql`${attendanceJustifications.status} in ('pending','approved')`,
            lte(attendanceJustifications.startDate, to),
            gte(attendanceJustifications.endDate, from),
          ),
        ),
      // READ-ONLY on the door schema: every ALLOW swipe of the month, credited to its card's
      // employee, with the event time already in local HCM — first_in/last_out are decided by the
      // same expansion rule the calendar uses, in JS, one pass.
      this.db
        .select({
          employeeId: doorCards.employeeId,
          date: sql<string>`to_char(${doorEvents.deviceTs} AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD')`,
          time: sql<string>`to_char(${doorEvents.deviceTs} AT TIME ZONE 'Asia/Ho_Chi_Minh', 'HH24:MI')`,
        })
        .from(doorEvents)
        .innerJoin(doorCards, eq(doorEvents.cardId, doorCards.id))
        .where(
          and(
            eq(doorEvents.result, 'allow'),
            gte(doorEvents.deviceTs, monthStart),
            lt(doorEvents.deviceTs, monthEnd),
          ),
        ),
    ]);

    const holidaySet = new Set(monthHolidays.map((h) => h.date));
    const workingDays = workingDatesInRange(from, to, holidaySet);
    const ids = new Set(people.map((p) => p.id));

    // Per employee per date: how many allow swipes, and their first and last times.
    const swipeIndex = new Map<string, { count: number; first: string; last: string }>();
    for (const swipe of swipes) {
      if (!ids.has(swipe.employeeId)) continue;
      const key = `${swipe.employeeId}|${swipe.date}`;
      const entry = swipeIndex.get(key) ?? { count: 0, first: swipe.time, last: swipe.time };
      entry.count += 1;
      // HH:MM strings compare correctly lexicographically.
      if (swipe.time < entry.first) entry.first = swipe.time;
      if (swipe.time > entry.last) entry.last = swipe.time;
      swipeIndex.set(key, entry);
    }

    // Per person per working date: leave portion, approved WFH, approved/pending justification —
    // all indexed once so each day of each person is a lookup, not another scan.
    const leaveDays = new Map<string, LeavePortion>();
    const wfhDays = new Set<string>();
    for (const person of people) {
      for (const date of workingDays) {
        const key = `${person.id}|${date}`;
        const leave = coveringLeave(leaveWindows.filter((l) => l.employeeId === person.id), date);
        if (leave) leaveDays.set(key, leave);
        if (
          wfhWindows.some(
            (w) => w.employeeId === person.id && w.startDate <= date && w.endDate >= date,
          )
        ) {
          wfhDays.add(key);
        }
      }
    }
    const justifiedDays = new Set<string>();
    const pendingJustifiedDays = new Set<string>();
    for (const j of justifications) {
      if (!ids.has(j.employeeId)) continue;
      for (const date of workingDatesInRange(j.startDate > from ? j.startDate : from, j.endDate < to ? j.endDate : to, holidaySet)) {
        const key = `${j.employeeId}|${date}`;
        // An approved repair wins over a pending one on the same day; both mean "explained", but
        // only the approved one credits.
          if (j.status === 'approved') justifiedDays.add(key);
        else if (!justifiedDays.has(key)) pendingJustifiedDays.add(key);
      }
    }

    const employeeMonths: EmployeeAttendanceMonth[] = people.map((person) => {
      const days = workingDays.map((date) => {
        const key = `${person.id}|${date}`;
        const swipes = swipeIndex.get(key);
        const day = computeAttendanceDay({
          date,
          holiday: holidaySet.has(date),
          leave: leaveDays.get(key) ?? null,
          // An approved WFH window counts on its working days only: it was costed against this
          // same calendar at submit, and a holiday added inside it later is not a WFH day.
          wfh: wfhDays.has(key),
          justified: justifiedDays.has(key),
          firstIn: swipes && swipes.count >= 1 ? swipes.first : null,
          lastOut: swipes && swipes.count >= 2 ? swipes.last : null,
          swipeCount: swipes?.count ?? 0,
        });
        return { ...day, pendingJustification: pendingJustifiedDays.has(key) };
      });
      return { id: person.id, name: person.name, department: person.department, days };
    });

    return { month, close: await this.getMonthClose(month), employees: employeeMonths };
  }

  async getMyMonth(month: string, actor: Actor): Promise<AttendanceMonth> {
    return this.getMonth(month, actor, actor.sub);
  }

  // ── Month close ─────────────────────────────────────────────────────────────

  async getMonthClose(month: string): Promise<MonthClose | null> {
    const [row] = await this.db
      .select()
      .from(attendanceMonthCloses)
      .where(eq(attendanceMonthCloses.month, month))
      .limit(1);
    return row ?? null;
  }

  /**
   * Refuse `what` when any month its date range falls into is closed. This is the lock: a closed
   * month accepts no new leave, WFH or justification, no decision on a pending one, and no
   * cancellation — reopening is the audited admin override.
   */
  async assertMonthsOpen(startDate: string, endDate: string, what: string): Promise<void> {
    const months = monthsOfRange(startDate, endDate);
    const closed = await this.db
      .select({ month: attendanceMonthCloses.month })
      .from(attendanceMonthCloses)
      .where(inArray(attendanceMonthCloses.month, months));
    if (closed.length > 0) {
      throw new PreconditionFailedException(
        ErrorCodes.ATTENDANCE_MONTH_CLOSED,
        `${what} touches ${closed.map((c) => c.month).sort().join(', ')}, which HR closed — an administrator must reopen the month first`,
      );
    }
  }

  async closeMonth(month: string, actor: Actor, note?: string): Promise<MonthClose> {
    const existing = await this.getMonthClose(month);
    if (existing) {
      throw new ConflictException(
        ErrorCodes.ATTENDANCE_MONTH_CLOSED,
        `${month} is already closed (by ${existing.closedBy} at ${existing.closedAt.toISOString()})`,
      );
    }
    const [row] = await this.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(attendanceMonthCloses)
        .values({ month, closedBy: actor.sub, note: note ?? null })
        .onConflictDoNothing()
        .returning();
      if (!inserted) {
        throw new ConflictException(ErrorCodes.ATTENDANCE_MONTH_CLOSED, `${month} was closed concurrently`);
      }
      await this.monthTrail.record(AUDIT_ACTION.ATTENDANCE_MONTH_CLOSED, month, actor, tx, {
        after: { month, note: note ?? null },
      });
      return [inserted];
    });
    return row;
  }

  /** The audited admin override. The route's permission is granted to no role — wildcard only. */
  async reopenMonth(month: string, actor: Actor, note: string): Promise<void> {
    const existing = await this.getMonthClose(month);
    if (!existing) {
      throw new PreconditionFailedException(
        ErrorCodes.ATTENDANCE_MONTH_NOT_CLOSED,
        `${month} is not closed`,
      );
    }
    await this.db.transaction(async (tx) => {
      await tx.delete(attendanceMonthCloses).where(eq(attendanceMonthCloses.month, month));
      await this.monthTrail.record(AUDIT_ACTION.ATTENDANCE_MONTH_REOPENED, month, actor, tx, {
        before: { month, closedBy: existing.closedBy, closedAt: existing.closedAt },
        after: { month, reason: note },
      });
    });
  }

  // ── Justifications ──────────────────────────────────────────────────────────

  async previewJustification(startDate: string, endDate: string): Promise<{ startDate: string; endDate: string; workingDays: string[] }> {
    const holidayRows = await this.db
      .select({ date: holidays.date })
      .from(holidays)
      .where(and(gte(holidays.date, startDate), lte(holidays.date, endDate)));
    const holidaySet = new Set(holidayRows.map((h) => h.date));
    return { startDate, endDate, workingDays: workingDatesInRange(startDate, endDate, holidaySet) };
  }

  async createJustification(
    input: { startDate: string; endDate: string; kind: 'late' | 'early' | 'forgot_card' | 'missing_checkout'; reason?: string },
    actor: Actor,
  ) {
    const workingDays = (await this.previewJustification(input.startDate, input.endDate)).workingDays;
    if (workingDays.length === 0) {
      throw new PreconditionFailedException(
        ErrorCodes.WFH_WINDOW_EMPTY,
        'That window covers no working day',
      );
    }
    // NO overlap rule with leave, WFH or other justifications: a justification explains days, it
    // does not spend them, so there is nothing to overlap.
    await this.assertMonthsOpen(input.startDate, input.endDate, 'A justification');

    const [row] = await this.db
      .insert(attendanceJustifications)
      .values({
        employeeId: actor.sub,
        startDate: input.startDate,
        endDate: input.endDate,
        workingDays: String(workingDays.length),
        kind: input.kind,
        reason: input.reason ?? null,
      })
      .returning();

    const payload: AttendanceJustificationPayload = {
      justificationId: row.id,
      employeeId: actor.sub,
      startDate: row.startDate,
      endDate: row.endDate,
      kind: row.kind,
      workingDays: workingDays.length,
      reason: row.reason,
    };
    const engineItem = await this.engine.submit('attendance_justification', payload, actor, {
      expiresAt: new Date(Date.now() + 72 * MS_PER_HOUR), // 3-day review window
    });

    await this.db.transaction(async (tx) => {
      await tx
        .update(attendanceJustifications)
        .set({ requestId: engineItem.id })
        .where(eq(attendanceJustifications.id, row.id));
      await this.justificationTrail.record(
        AUDIT_ACTION.ATTENDANCE_JUSTIFICATION_REQUESTED,
        row.id,
        actor,
        tx,
        { after: { startDate: row.startDate, endDate: row.endDate, kind: row.kind, workingDays: workingDays.length, engineRequestId: engineItem.id } },
      );
    });
    return { ...row, requestId: engineItem.id };
  }

  async listJustifications(filters: { employeeId?: string; status?: 'pending' | 'approved' | 'rejected' | 'cancelled' }, actor: Actor) {
    const narrowed = await this.actorScope.narrowFilter(
      filters,
      'employeeId',
      actor,
      'workforce.attendance.read',
    );
    const conditions = [
      narrowed.employeeId ? eq(attendanceJustifications.employeeId, narrowed.employeeId) : undefined,
      narrowed.status ? eq(attendanceJustifications.status, narrowed.status) : undefined,
    ].filter(Boolean);
    return this.db
      .select()
      .from(attendanceJustifications)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(sql`${attendanceJustifications.startDate} desc, ${attendanceJustifications.id} desc`)
      .limit(REPORT_ROW_LIMIT);
  }

  async getJustification(id: string) {
    const [row] = await this.db
      .select()
      .from(attendanceJustifications)
      .where(eq(attendanceJustifications.id, id))
      .limit(1);
    if (!row) throw new NotFoundException(ErrorCodes.ATTENDANCE_JUSTIFICATION_NOT_FOUND, 'Justification not found');
    return row;
  }

  async reviewJustification(id: string, approve: boolean, actor: Actor) {
    const row = await this.getJustification(id);
    if (row.status !== 'pending') {
      throw new PreconditionFailedException(
        ErrorCodes.ATTENDANCE_JUSTIFICATION_NOT_PENDING,
        'Only pending justifications can be reviewed',
      );
    }
    await this.assertMonthsOpen(row.startDate, row.endDate, 'Deciding a justification');
    if (approve) await this.engine.approve(row.requestId!, null, actor);
    else await this.engine.reject(row.requestId!, null, actor);
    return this.getJustification(id);
  }

  async cancelJustification(id: string, actor: Actor) {
    const row = await this.getJustification(id);
    if (row.employeeId !== actor.sub && !(await this.authz.check(actor.sub, 'workforce.attendance.review'))) {
      throw new PermissionDeniedException('Only the requester may withdraw a justification');
    }
    if (row.status !== 'pending') {
      throw new PreconditionFailedException(
        ErrorCodes.ATTENDANCE_JUSTIFICATION_NOT_PENDING,
        'Only a pending justification can be withdrawn',
      );
    }
    await this.assertMonthsOpen(row.startDate, row.endDate, 'Withdrawing a justification');
    await this.db.transaction(async (tx) => {
      await tx
        .update(attendanceJustifications)
        .set({ status: 'cancelled' })
        .where(eq(attendanceJustifications.id, id));
      await this.justificationTrail.record(AUDIT_ACTION.ATTENDANCE_JUSTIFICATION_CANCELLED, id, actor, tx, {
        before: { status: 'pending' },
        after: { status: 'cancelled' },
      });
    });
    return this.getJustification(id);
  }
}

/** Which part of `date` an approved leave window takes, if any. */
function coveringLeave(
  windows: { startDate: string; endDate: string; startPortion: 'full_day' | 'morning' | 'afternoon'; endPortion: 'full_day' | 'morning' | 'afternoon' }[],
  date: string,
): LeavePortion | null {
  let widest: LeavePortion | null = null;
  for (const window of windows as PtoWindow[]) {
    const portion = portionOn(window, date);
    if (portion === 'full_day') return 'full_day';
    if (portion) widest = portion;
  }
  return widest;
}

export type { DayFlag };
