import { Injectable } from '@nestjs/common';
import { and, asc, eq, gte, lte, ne } from 'drizzle-orm';
import { ErrorCodes, InjectDrizzle, PreconditionFailedException, type DrizzleDB } from '@platform';
import {
  AuditService,
  AUDIT_ACTION,
  AUDIT_RESOURCE,
  type ResourceAuditTrail,
} from '@modules/audit';
import type { Actor } from '@shared-kernel';
import { lastDayOf, wioDayProblem } from '../domain/wio-day';
import { ptoMarksInRange, type PtoMark } from '../domain/wio-pto';
import { employees, leaveRequests, wfhDays } from '../../../../../db/schema';

export interface WioMonth {
  month: string;
  people: { id: string; name: string; department: string | null }[];
  wfh: { employeeId: string; date: string }[];
  pto: PtoMark[];
}

/**
 * The WIO ("working in office") calendar.
 *
 * The stored fact is only "this person works from home on this date". Being in the office is the
 * absence of that fact, so nothing here ever has to fill the future in or reconcile a joiner.
 *
 * WHO CAN SEE WHAT. `getMonth` is the one deliberately company-wide read in the workforce module:
 * the point of the calendar is that everybody sees where everybody is. It returns a name, a
 * department and a date — no hours, no leave reasons — and the controller declares it `shared-read`
 * so that choice is visible in the route audit rather than implied by a missing decorator. Writes
 * are `self-scoped`: the employee is always the caller, never a parameter.
 */
@Injectable()
export class WioCalendarService {
  private readonly trail: ResourceAuditTrail;

  constructor(
    audit: AuditService,
    @InjectDrizzle() private readonly db: DrizzleDB,
  ) {
    this.trail = audit.forResource(AUDIT_RESOURCE.WFH_DAY);
  }

  async getMonth(month: string): Promise<WioMonth> {
    const from = `${month}-01`;
    const to = lastDayOf(month);

    const [people, marks, leave] = await Promise.all([
      this.db
        .select({ id: employees.id, name: employees.displayName, department: employees.department })
        .from(employees)
        // `on_leave` stays: they are still somebody the calendar should account for. Only people who
        // have left drop out.
        .where(ne(employees.status, 'offboarded'))
        // `id` breaks ties between two people with the same display name, so the order is stable.
        .orderBy(asc(employees.displayName), asc(employees.id)),
      this.db
        .select({ employeeId: wfhDays.employeeId, date: wfhDays.workDate })
        .from(wfhDays)
        .where(and(gte(wfhDays.workDate, from), lte(wfhDays.workDate, to))),
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
    ]);

    // Only people the calendar accounts for: a mark left by somebody who has since left the company, or an
    // id with no employee row, would otherwise ride along for nothing.
    const known = new Set(people.map((p) => p.id));
    return {
      month,
      people,
      wfh: marks.filter((m) => known.has(m.employeeId)),
      pto: ptoMarksInRange(
        leave.filter((l) => known.has(l.employeeId)),
        from,
        to,
      ),
    };
  }

  /**
   * Set whether the CALLER works from home on `date`. Idempotent: setting a day to the state it is
   * already in changes nothing and writes no audit entry.
   */
  async setDay(date: string, wfh: boolean, actor: Actor): Promise<{ date: string; wfh: boolean }> {
    const problem = wioDayProblem(date);
    if (problem) throw new PreconditionFailedException(ErrorCodes.WFH_DAY_NOT_EDITABLE, problem);

    await this.db.transaction(async (tx) => {
      if (wfh) {
        const inserted = await tx
          .insert(wfhDays)
          .values({ employeeId: actor.sub, workDate: date })
          // The unique (employee, date) index makes a repeat a no-op instead of an error.
          .onConflictDoNothing()
          .returning({ id: wfhDays.id });
        const [row] = inserted;
        if (row) {
          await this.trail.record(AUDIT_ACTION.WFH_MARKED, row.id, actor, tx, {
            after: { date },
          });
        }
        return;
      }
      const removed = await tx
        .delete(wfhDays)
        .where(and(eq(wfhDays.employeeId, actor.sub), eq(wfhDays.workDate, date)))
        .returning({ id: wfhDays.id });
      const [row] = removed;
      if (row) {
        await this.trail.record(AUDIT_ACTION.WFH_CLEARED, row.id, actor, tx, {
          before: { date },
        });
      }
    });

    return { date, wfh };
  }
}
