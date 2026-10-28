import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gte, inArray, lt, lte, sql } from 'drizzle-orm';
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
import { employmentContracts } from '../../../../../db/schema/contracts';
import {
  computeAttendanceDay,
  type AttendanceDay,
  type DayFlag,
  type LeavePortion,
} from '../domain/attendance-day';
import { lockMonthsInTx, monthsOfRange } from '../domain/attendance-month-lock';

export { monthsOfRange };
import { lastDayOf } from '../domain/wio-day';
import { portionOn, type PtoWindow } from '../domain/wio-pto';
import { workingDatesInRange } from '../domain/working-days';
import {
  WORKFORCE_REPOSITORY,
  type IWorkforceRepository,
} from '../domain/ports/workforce.repository';
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
  /** Employment status as of now — the sweep skips the offboarded; historical months keep them. */
  status?: string;
  days: (AttendanceDay & {
    pendingJustification: boolean;
    leaveType: string | null;
    /** Which part of the day approved leave takes, when any — the CSVs count halves. */
    leavePortion: LeavePortion | null;
  })[];
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
export function monthInstantBounds(month: string): [Date, Date] {
  // The next month through Date arithmetic, NOT String(m + 1): December's "13" is not a month, and
  // an invalid bound silently matched nothing (no December events ever reached the view).
  const [y, m] = month.split('-').map(Number) as [number, number];
  const next = new Date(Date.UTC(y, m, 1)); // month is 0-based, so `m` already IS the next month
  const nextKey = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}`;
  return [
    new Date(`${month}-01T00:00:00${HCM_UTC_OFFSET}`),
    new Date(`${nextKey}-01T00:00:00${HCM_UTC_OFFSET}`),
  ];
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
  private async scopedEmployees(
    actor: Actor,
    month: string,
    employeeId?: string,
  ): Promise<{ id: string; name: string; department: string | null }[]> {
    const readsAll = await this.authz.check(actor.sub, 'workforce.attendance.read');
    if (readsAll) {
      const rows = await this.rosterForMonth(month);
      return employeeId ? rows.filter((r) => r.id === employeeId) : rows;
    }
    const team = await this.db
      .select({ id: employees.id, name: employees.displayName, department: employees.department })
      .from(employees)
      .where(eq(employees.managerId, actor.sub));
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

  /**
   * Everyone a month must still account for: the employed-now, plus OFFBOARDED people whose
   * employment overlapped the month (their past attendance did not leave with them — a closed
   * October must still show somebody who left in November). Employment windows come from the
   * employment contracts; a person with no contract row is kept unbounded rather than hidden.
   */
  private async rosterForMonth(
    month: string,
  ): Promise<{ id: string; name: string; department: string | null; status: string }[]> {
    const from = `${month}-01`;
    const to = lastDayOf(month);
    const rows = await this.db
      .select({
        id: employees.id,
        name: employees.displayName,
        department: employees.department,
        status: employees.status,
      })
      .from(employees)
      .orderBy(asc(employees.displayName), asc(employees.id));
    const contracts = await this.employmentByEmployee(rows.map((r) => r.id));
    return rows.filter((r) => {
      if (r.status !== 'offboarded') return true;
      const employment = contracts.get(r.id);
      if (!employment) return false;
      // Overlap of the employment window with the month.
      return employment.start <= to && (employment.end ?? '9999-12-31') >= from;
    });
  }

  /**
   * Each employee's employment window from their contracts: earliest start, and the latest end —
   * where ANY null end means open-ended (an indefinite contract, e.g. the renewal after a
   * fixed-term one) and wins over every dated end regardless of row order. Only contracts that
   * were ever in force count (`active`, `expired`, `terminated`); a `draft` never started.
   */
  private async employmentByEmployee(
    ids: string[],
  ): Promise<Map<string, { start: string; end: string | null }>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .select({
        employeeId: employmentContracts.employeeId,
        startDate: employmentContracts.startDate,
        endDate: employmentContracts.endDate,
      })
      .from(employmentContracts)
      .where(
        and(
          inArray(employmentContracts.employeeId, ids),
          inArray(employmentContracts.status, ['active', 'expired', 'terminated']),
        ),
      );
    return employmentWindows(rows);
  }

  // ── The derived month ───────────────────────────────────────────────────────

  /** The month through a viewer's scope — the one derivation, filtered per audience. */
  private async computeMonthFor(
    month: string,
    actor: Actor,
    employeeId?: string,
  ): Promise<{ month: string; employees: EmployeeAttendanceMonth[] }> {
    const allowed = await this.scopedEmployees(actor, month, employeeId);
    const allowedIds = new Set(allowed.map((e) => e.id));
    const whole = await this.computeMonth(month);
    return { month, employees: whole.employees.filter((e) => allowedIds.has(e.id)) };
  }

  async getMonth(month: string, actor: Actor, employeeId?: string): Promise<AttendanceMonth> {
    const whole = await this.computeMonthFor(month, actor, employeeId);
    return { ...whole, close: await this.getMonthClose(month) };
  }

  /**
   * The derived month for EVERYBODY the roster accounts for — the one implementation of the
   * derivation, shared by the scoped reads, the CSVs and the morning sweep.
   */
  async computeMonth(
    month: string,
  ): Promise<{ month: string; employees: EmployeeAttendanceMonth[] }> {
    const people = await this.rosterForMonth(month);
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
          leaveType: leaveRequests.leaveType,
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
          // The event time is the DEVICE clock when the terminal had one (`time_synced`), and the
          // server's receive time when it did not — an unsynced terminal's timestamps are fiction,
          // and `receivedAt` is the honest fallback. A day built on fallback times carries the
          // `unsynced` flag. The WHERE uses the same CASE, so the month window is judged on the
          // time the day is built from.
          date: sql<string>`to_char((case when ${doorEvents.timeSynced} then ${doorEvents.deviceTs} else ${doorEvents.receivedAt} end) AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD')`,
          time: sql<string>`to_char((case when ${doorEvents.timeSynced} then ${doorEvents.deviceTs} else ${doorEvents.receivedAt} end) AT TIME ZONE 'Asia/Ho_Chi_Minh', 'HH24:MI')`,
          timeSynced: doorEvents.timeSynced,
        })
        .from(doorEvents)
        .innerJoin(doorCards, eq(doorEvents.cardId, doorCards.id))
        .where(
          and(
            eq(doorEvents.result, 'allow'),
            gte(
              sql`case when ${doorEvents.timeSynced} then ${doorEvents.deviceTs} else ${doorEvents.receivedAt} end`,
              monthStart,
            ),
            lt(
              sql`case when ${doorEvents.timeSynced} then ${doorEvents.deviceTs} else ${doorEvents.receivedAt} end`,
              monthEnd,
            ),
          ),
        ),
    ]);

    const holidaySet = new Set(monthHolidays.map((h) => h.date));
    const workingDays = workingDatesInRange(from, to, holidaySet);
    const ids = new Set(people.map((p) => p.id));

    // Per employee per date: how many allow swipes, and their first and last times.
    const swipeIndex = new Map<
      string,
      { count: number; first: string; last: string; unsynced: boolean }
    >();
    for (const swipe of swipes) {
      if (!ids.has(swipe.employeeId)) continue;
      const key = `${swipe.employeeId}|${swipe.date}`;
      const entry = swipeIndex.get(key) ?? {
        count: 0,
        first: swipe.time,
        last: swipe.time,
        unsynced: false,
      };
      entry.count += 1;
      // HH:MM strings compare correctly lexicographically.
      if (swipe.time < entry.first) entry.first = swipe.time;
      if (swipe.time > entry.last) entry.last = swipe.time;
      if (!swipe.timeSynced) entry.unsynced = true;
      swipeIndex.set(key, entry);
    }

    // Per person per working date: leave portion, approved WFH, approved/pending justification —
    // all indexed once so each day of each person is a lookup, not another scan.
    const leaveDays = new Map<string, { portion: LeavePortion; type: string }>();
    const wfhDays = new Set<string>();
    for (const person of people) {
      for (const date of workingDays) {
        const key = `${person.id}|${date}`;
        const leave = coveringLeave(
          leaveWindows.filter((l) => l.employeeId === person.id),
          date,
        );
        if (leave) {
          const window = leaveWindows.find(
            (l) => l.employeeId === person.id && portionOn(l, date) === leave,
          );
          leaveDays.set(key, { portion: leave, type: window?.leaveType ?? 'other' });
        }
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
      for (const date of workingDatesInRange(
        j.startDate > from ? j.startDate : from,
        j.endDate < to ? j.endDate : to,
        holidaySet,
      )) {
        const key = `${j.employeeId}|${date}`;
        // An approved repair wins over a pending one on the same day; both mean "explained", but
        // only the approved one credits.
        // Order-independent: an APPROVED repair outranks a PENDING one on the same day whichever
        // order the rows came back in; subtracting at the end keeps a decided day from reading
        // "still waiting".
        if (j.status === 'approved') justifiedDays.add(key);
        else pendingJustifiedDays.add(key);
      }
    }
    for (const key of justifiedDays) pendingJustifiedDays.delete(key);

    const employment = await this.employmentByEmployee(people.map((p) => p.id));
    const employeeMonths: EmployeeAttendanceMonth[] = people.map((person) => {
      // Bound the days by EMPLOYMENT: nobody is absent before they were hired or after their last
      // contract ended — those days simply did not exist for them.
      const window = employment.get(person.id);
      const days = workingDays
        .filter((date) => !window || (date >= window.start && date <= (window.end ?? '9999-12-31')))
        .map((date) => {
          const key = `${person.id}|${date}`;
          const swipes = swipeIndex.get(key);
          const leave = leaveDays.get(key);
          const day = computeAttendanceDay({
            date,
            holiday: holidaySet.has(date),
            unsynced: swipes?.unsynced ?? false,
            leave: leave?.portion ?? null,
            // An approved WFH window counts on its working days only: it was costed against this
            // same calendar at submit, and a holiday added inside it later is not a WFH day.
            wfh: wfhDays.has(key),
            justified: justifiedDays.has(key),
            firstIn: swipes && swipes.count >= 1 ? swipes.first : null,
            lastOut: swipes && swipes.count >= 2 ? swipes.last : null,
            swipeCount: swipes?.count ?? 0,
          });
          return {
            ...day,
            leaveType: leave?.type ?? null,
            leavePortion: leave?.portion ?? null,
            pendingJustification: pendingJustifiedDays.has(key),
          };
        });
      return {
        id: person.id,
        name: person.name,
        department: person.department,
        status: person.status,
        days,
      };
    });

    return { month, employees: employeeMonths };
  }

  async getMyMonth(month: string, actor: Actor): Promise<AttendanceMonth> {
    return this.getMonth(month, actor, actor.sub);
  }

  // ── CSVs ────────────────────────────────────────────────────────────────────

  /**
   * The monthly summary, one row per employee: office days, WFH days, leave days by type, unpaid
   * days, unexcused absences, late and early counts, total hours — the owner's list, in that order.
   */
  async summaryCsv(month: string, actor: Actor): Promise<string> {
    const whole = await this.computeMonthFor(month, actor);
    const header =
      'employee,department,office_days,wfh_days,leave_annual,leave_sick,leave_unpaid,' +
      'leave_parental,leave_other,unexcused_absences,late_count,early_count,total_hours';
    const lines = whole.employees.map((person) => {
      const counts = {
        office: 0,
        wfh: 0,
        annual: 0,
        sick: 0,
        unpaid: 0,
        parental: 0,
        other: 0,
        absences: 0,
        late: 0,
        early: 0,
        minutes: 0,
      };
      for (const day of person.days) {
        // Half days count HALF: a morning of leave plus an afternoon in the office is 0.5 leave
        // and 0.5 office, not one of each — the sheet must add up to the month's working days.
        const whole = day.leavePortion === 'morning' || day.leavePortion === 'afternoon' ? 0.5 : 1;
        if (day.status === 'wfh') counts.wfh += whole;
        else if (day.status === 'absent') counts.absences += whole;
        else if (day.status === 'office') counts.office += whole;
        if (day.leaveType) {
          // A leave type the sheet has no column for (a new enum value) is counted as `other`,
          // never `undefined + 0.5` = NaN in the file.
          counts[LEAVE_COLUMNS.has(day.leaveType) ? (day.leaveType as LeaveColumn) : 'other'] +=
            whole;
        }
        if (day.flags.includes('late')) counts.late += 1;
        if (day.flags.includes('early')) counts.early += 1;
        counts.minutes += day.workedMinutes;
      }
      return [
        csvField(person.name),
        csvField(person.department),
        counts.office,
        counts.wfh,
        counts.annual,
        counts.sick,
        counts.unpaid,
        counts.parental,
        counts.other,
        counts.absences,
        counts.late,
        counts.early,
        (counts.minutes / 60).toFixed(2),
      ].join(',');
    });
    return [header, ...lines].join('\r\n') + '\r\n';
  }

  /** The per-day sheet: every working day of every employee, one row per (employee, day). */
  async daysCsv(month: string, actor: Actor): Promise<string> {
    const whole = await this.computeMonthFor(month, actor);
    const header =
      'employee,department,date,status,worked_hours,late_minutes,early_minutes,flags,justification_pending';
    const lines: string[] = [];
    for (const person of whole.employees) {
      for (const day of person.days) {
        lines.push(
          [
            csvField(person.name),
            csvField(person.department),
            day.date,
            day.status,
            (day.workedMinutes / 60).toFixed(2),
            day.lateMinutes ?? '',
            day.earlyMinutes ?? '',
            day.flags.length ? `"${day.flags.join(' ')}"` : '',
            day.pendingJustification ? 'yes' : '',
          ].join(','),
        );
      }
    }
    return [header, ...lines].join('\r\n') + '\r\n';
  }

  // ── The morning sweep ───────────────────────────────────────────────────────

  /**
   * Every CURRENTLY-EMPLOYED person with unresolved flags on `date` (a working day), for the
   * morning notification: the person themselves, so yesterday's problems are in front of them
   * while a justification can still be filed. A day with a PENDING justification is skipped —
   * nagging somebody whose explanation is already on a manager's desk asks for nothing.
   */
  async unresolvedFlagsFor(
    date: string,
  ): Promise<{ employeeId: string; name: string; flags: string[] }[]> {
    const month = date.slice(0, 7);
    const whole = await this.computeMonth(month);
    const out: { employeeId: string; name: string; flags: string[] }[] = [];
    for (const person of whole.employees) {
      // Offboarded people stay in historical months, but the morning sweep is for the people who
      // can still file a justification today.
      if (person.status === 'offboarded') continue;
      const day = person.days.find((d) => d.date === date);
      if (!day || day.flags.length === 0 || day.pendingJustification) continue;
      out.push({ employeeId: person.id, name: person.name, flags: day.flags });
    }
    return out;
  }

  /**
   * The previous WORKING day before `now` in HCM: step back over weekends and the holiday
   * calendar — Monday morning reports Friday, and the morning after a holiday reports the last
   * worked day, not the holiday nobody was expected in for.
   */
  async previousWorkingDay(
    now: Date = new Date(),
    knownHolidays?: ReadonlySet<string>,
  ): Promise<string> {
    const hcmNow = new Date(now.getTime() + 7 * 3_600_000);
    let date = hcmNow.toISOString().slice(0, 10);
    for (let i = 0; i < 10; i += 1) {
      date = new Date(new Date(`${date}T00:00:00Z`).getTime() - 86_400_000)
        .toISOString()
        .slice(0, 10);
      const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
      if (weekday === 0 || weekday === 6) continue;
      if (knownHolidays) {
        if (!knownHolidays.has(date)) return date;
        continue;
      }
      const [holiday] = await this.db
        .select({ date: holidays.date })
        .from(holidays)
        .where(eq(holidays.date, date))
        .limit(1);
      if (!holiday) return date;
    }
    return date;
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
        `${what} touches ${closed
          .map((c) => c.month)
          .sort()
          .join(', ')}, which HR closed — an administrator must reopen the month first`,
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
      // The same advisory lock the type-def hooks take, so a close serializes against every
      // in-flight decision on the month instead of racing it.
      await lockMonthsInTx(tx, month);
      const [inserted] = await tx
        .insert(attendanceMonthCloses)
        .values({ month, closedBy: actor.sub, note: note ?? null })
        .onConflictDoNothing()
        .returning();
      if (!inserted) {
        throw new ConflictException(
          ErrorCodes.ATTENDANCE_MONTH_CLOSED,
          `${month} was closed concurrently`,
        );
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

  async previewJustification(
    startDate: string,
    endDate: string,
  ): Promise<{ startDate: string; endDate: string; workingDays: string[] }> {
    const holidayRows = await this.db
      .select({ date: holidays.date })
      .from(holidays)
      .where(and(gte(holidays.date, startDate), lte(holidays.date, endDate)));
    const holidaySet = new Set(holidayRows.map((h) => h.date));
    return { startDate, endDate, workingDays: workingDatesInRange(startDate, endDate, holidaySet) };
  }

  async createJustification(
    input: {
      startDate: string;
      endDate: string;
      kind: 'late' | 'early' | 'forgot_card' | 'missing_checkout';
      reason?: string;
    },
    actor: Actor,
  ) {
    const workingDays = (await this.previewJustification(input.startDate, input.endDate))
      .workingDays;
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
        {
          after: {
            startDate: row.startDate,
            endDate: row.endDate,
            kind: row.kind,
            workingDays: workingDays.length,
            engineRequestId: engineItem.id,
          },
        },
      );
    });
    return { ...row, requestId: engineItem.id };
  }

  async listJustifications(
    filters: { employeeId?: string; status?: 'pending' | 'approved' | 'rejected' | 'cancelled' },
    actor: Actor,
  ) {
    const narrowed = await this.actorScope.narrowFilter(
      filters,
      'employeeId',
      actor,
      'workforce.attendance.read',
    );
    const conditions = [
      narrowed.employeeId
        ? eq(attendanceJustifications.employeeId, narrowed.employeeId)
        : undefined,
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
    if (!row)
      throw new NotFoundException(
        ErrorCodes.ATTENDANCE_JUSTIFICATION_NOT_FOUND,
        'Justification not found',
      );
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
    /*
     * THE REQUESTER ONLY. A reviewer withdrawing somebody's explanation is a decision wearing a
     * withdrawal's clothes — reject exists for that. (An administrator still can, through the
     * engine's own admin-cancel on `rbac.manage`, which audits them as the actor.)
     */
    if (row.employeeId !== actor.sub) {
      throw new PermissionDeniedException(
        'Only the requester may withdraw their own justification',
      );
    }
    if (row.status !== 'pending') {
      throw new PreconditionFailedException(
        ErrorCodes.ATTENDANCE_JUSTIFICATION_NOT_PENDING,
        'Only a pending justification can be withdrawn',
      );
    }
    if (!row.requestId) {
      throw new PreconditionFailedException(
        ErrorCodes.ATTENDANCE_JUSTIFICATION_NOT_PENDING,
        'This justification has no approval item; it cannot be withdrawn',
      );
    }
    await this.assertMonthsOpen(row.startDate, row.endDate, 'Withdrawing a justification');
    // Through the engine: the item and the row change in ONE transaction, the onCancel hook
    // guarding both pending — the same pairing leave and WFH withdrawals use.
    await this.engine.cancel(row.requestId, actor);
    return this.getJustification(id);
  }
}

/** The leave columns the summary sheet has. Anything else is counted under `other`. */
type LeaveColumn = 'annual' | 'sick' | 'unpaid' | 'parental' | 'other';
const LEAVE_COLUMNS: ReadonlySet<string> = new Set<LeaveColumn>([
  'annual',
  'sick',
  'unpaid',
  'parental',
  'other',
]);

/**
 * A CSV field: a leading `=`, `+`, `-`, `@`, tab or CR is neutralised with a leading apostrophe,
 * because those are the characters a spreadsheet turns into a FORMULA — a name is data, never
 * code. The apostrophe goes INSIDE the quotes: it must be part of the cell's value, not a stray
 * character in front of the opening quote (which would make the quote itself literal).
 * Then the field is quoted when it contains a comma, quote or newline, with quotes doubled.
 */
export function csvField(value: string | null): string {
  if (value === null) return '';
  const safe = /^[=+@\t\r-]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** Fold contract rows into one window per employee. See `employmentByEmployee` for the rule. */
export function employmentWindows(
  rows: { employeeId: string; startDate: string; endDate: string | null }[],
): Map<string, { start: string; end: string | null }> {
  const windows = new Map<string, { start: string; end: string | null }>();
  for (const row of rows) {
    const w = windows.get(row.employeeId);
    if (!w) {
      windows.set(row.employeeId, { start: row.startDate, end: row.endDate });
      continue;
    }
    const start = row.startDate < w.start ? row.startDate : w.start;
    const end =
      w.end === null || row.endDate === null ? null : w.end > row.endDate ? w.end : row.endDate;
    windows.set(row.employeeId, { start, end });
  }
  return windows;
}

/** Which part of `date` an approved leave window takes, if any. */
function coveringLeave(
  windows: {
    startDate: string;
    endDate: string;
    startPortion: 'full_day' | 'morning' | 'afternoon';
    endPortion: 'full_day' | 'morning' | 'afternoon';
  }[],
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
