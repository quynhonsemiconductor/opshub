import { Injectable } from '@nestjs/common';
import { and, asc, eq, gte, lte, ne, sql } from 'drizzle-orm';
import { AuthzService, InjectDrizzle, type DrizzleDB } from '@platform';
import type { Actor } from '@shared-kernel';
import type { PtoMark } from '../domain/wio-pto';
import { ptoMarksInRange } from '../domain/wio-pto';
import { lastDayOf } from '../domain/wio-day';
import { workingDatesInRange } from '../domain/working-days';
import { employees, holidays, leaveRequests, wfhRequests } from '../../../../../db/schema';

/** A WFH day on the calendar: whose, when, and whether a manager has signed off on it yet. */
export interface WfhMark {
  employeeId: string;
  date: string;
  status: 'approved' | 'pending';
}

export interface WioMonth {
  month: string;
  people: { id: string; name: string; department: string | null }[];
  wfh: WfhMark[];
  pto: PtoMark[];
  /** The month's public holidays, so the calendar can say WHY a day has nobody in. */
  holidays: { date: string; name: string }[];
}

/**
 * The WIO ("working in office") calendar.
 *
 * WHO CAN SEE WHAT. `getMonth` is the one deliberately company-wide read in the workforce module:
 * the point of the calendar is that everybody sees where everybody is. It returns a name, a
 * department and a date — no hours, no leave reasons — and the controller declares it `shared-read`
 * so that choice is visible in the route audit rather than implied by a missing decorator.
 *
 * WFH comes from REQUESTS, not self-ticks (owner rules 2026-10-28): a day counts as WFH only when a
 * request covering it stands approved, and a pending one is shown as pending — the manager may
 * still say no, and the calendar says so rather than reading the day as settled. Being in the
 * office remains the default: no request, no mark.
 */
@Injectable()
export class WioCalendarService {
  constructor(
    private readonly authz: AuthzService,
    @InjectDrizzle() private readonly db: DrizzleDB,
  ) {}

  async getMonth(month: string, viewer?: Actor): Promise<WioMonth> {
    const from = `${month}-01`;
    const to = lastDayOf(month);

    const [roster, wfhWindows, leave, monthHolidays] = await Promise.all([
      this.db
        .select({
          id: employees.id,
          name: employees.displayName,
          department: employees.department,
          managerId: employees.managerId,
        })
        .from(employees)
        // `on_leave` stays: they are still somebody the calendar should account for. Only people who
        // have left drop out.
        .where(ne(employees.status, 'offboarded'))
        // `id` breaks ties between two people with the same display name, so the order is stable.
        .orderBy(asc(employees.displayName), asc(employees.id)),
      this.db
        .select({
          employeeId: wfhRequests.employeeId,
          startDate: wfhRequests.startDate,
          endDate: wfhRequests.endDate,
          status: wfhRequests.status,
        })
        .from(wfhRequests)
        .where(
          and(
            // Rejected and cancelled requests released their days back to the office.
            sql`${wfhRequests.status} in ('pending','approved')`,
            lte(wfhRequests.startDate, to),
            gte(wfhRequests.endDate, from),
          ),
        ),
      // APPROVED ONLY. A pending request is not a decision yet, and showing it would announce leave the
      // manager may still refuse. The window overlaps the month when it starts before the month ends and
      // ends after the month starts.
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
        .select({ date: holidays.date, name: holidays.name })
        .from(holidays)
        .where(and(gte(holidays.date, from), lte(holidays.date, to))),
    ]);

    // Only people the calendar accounts for: a mark left by somebody who has since left the company, or an
    // id with no employee row, would otherwise ride along for nothing.
    const people = roster.map(({ id, name, department }) => ({ id, name, department }));
    const known = new Set(people.map((p) => p.id));
    const holidayDates = new Set(monthHolidays.map((h) => h.date));
    const marks = wfhMarksInRange(
      wfhWindows.filter((w) => known.has(w.employeeId)),
      from,
      to,
      holidayDates,
    );
    // WHO SEES A PENDING MARK. Approved WFH is a settled fact about where somebody works, so
    // everybody sees it; a PENDING request is not settled — the manager may still say no, and the
    // plans it would disturb are the person's own and their manager's. Pending shows to the
    // requester, their manager and HR (a workforce.manage holder); everyone else — and any
    // caller that names no viewer — sees the person as simply in the office. Leave stays
    // APPROVED-only for everyone, with no type: "away", never why.
    // `undefined` = no viewer (nobody sees pending); `null` = everybody (HR); a Set = those ids.
    const pendingVisibleTo = viewer ? await this.pendingVisibleTo(viewer, roster) : undefined;
    return {
      month,
      people,
      wfh: marks.filter(
        (m) =>
          m.status === 'approved' ||
          pendingVisibleTo === null ||
          (pendingVisibleTo?.has(m.employeeId) ?? false),
      ),
      pto: ptoMarksInRange(
        leave.filter((l) => known.has(l.employeeId)),
        from,
        to,
      ),
      holidays: monthHolidays,
    };
  }

  /**
   * The ids whose PENDING marks `viewer` may see: themself, their direct reports, and — as null,
   * meaning "everybody" — HR, i.e. a `workforce.manage` holder. NOT `workforce.read`: managers
   * hold that too, and a manager must see only their own reports' pending requests.
   */
  private async pendingVisibleTo(
    viewer: Actor,
    roster: { id: string; managerId: string | null }[],
  ): Promise<Set<string> | null> {
    if (await this.authz.check(viewer.sub, 'workforce.manage')) return null;
    return new Set([
      viewer.sub,
      ...roster.filter((p) => p.managerId === viewer.sub).map((p) => p.id),
    ]);
  }
}

/**
 * One mark per person per working day of `[from, to]` that a live WFH window covers.
 *
 * The same expansion `createWfh` froze on the request — weekends and the month's holidays skipped —
 * so a holiday declared after a request was approved cannot make a WFH mark appear on a day nobody
 * works. When a pending and an approved window somehow cover one day (submit refuses it; this is
 * defence), the approved one wins: the settled answer outranks the question.
 */
export function wfhMarksInRange(
  windows: {
    employeeId: string;
    startDate: string;
    endDate: string;
    status: string;
  }[],
  from: string,
  to: string,
  holidayDates: ReadonlySet<string>,
): WfhMark[] {
  const marks = new Map<string, WfhMark>();
  for (const window of windows) {
    // The SQL already filters to live rows; this guard is what narrows the type to the two
    // values a mark can carry, without a cast.
    if (window.status !== 'approved' && window.status !== 'pending') continue;
    const start = window.startDate > from ? window.startDate : from;
    const end = window.endDate < to ? window.endDate : to;
    if (end < start) continue;
    for (const date of workingDatesInRange(start, end, holidayDates)) {
      const key = `${window.employeeId}|${date}`;
      const existing = marks.get(key);
      if (!existing || (window.status === 'approved' && existing.status === 'pending')) {
        marks.set(key, { employeeId: window.employeeId, date, status: window.status });
      }
    }
  }
  return [...marks.values()];
}
