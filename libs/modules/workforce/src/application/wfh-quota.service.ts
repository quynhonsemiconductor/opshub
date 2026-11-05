import { Injectable } from '@nestjs/common';
import { and, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import {
  ErrorCodes,
  InjectDrizzle,
  PreconditionFailedException,
  type DbExecutor,
  type DrizzleDB,
} from '@platform';
import { employeeRoles, roles, rankBenefits, wfhRequests } from '../../../../../db/schema';
import { RANK_BENEFIT_CODE } from '@modules/roles';
import {
  HO_CHI_MINH_UTC_OFFSET_HOURS,
  WFH_WEEKLY_DAYS_WITHOUT_BENEFIT,
} from '../workforce.constants';
import { countDatesPerWeek, weekEndOf, weekStartOf } from '../domain/wfh-week.helper';

/** WFH requests that still claim quota: filed and waiting, or approved. Rejected and cancelled give it back. */
const _QUOTA_CLAIMING_STATUSES = ['pending', 'approved'] as const;

/** An employee's work-from-home quota for one Monday–Sunday week. */
export interface WfhWeekQuota {
  /** Monday of the week, `YYYY-MM-DD`. */
  weekStart: string;
  /** Sunday of the week, `YYYY-MM-DD`. */
  weekEnd: string;
  /** Days the employee's rank allows per week. */
  weeklyAllowance: number;
  /** Working days already claimed by pending and approved requests in this week. */
  usedDays: number;
  /** `weeklyAllowance - usedDays`, never below zero. */
  remainingDays: number;
}

/**
 * Weekly work-from-home quota.
 *
 * THE RULES. Every employee has a weekly allowance set by the rank of their current role
 * (`rank_benefits`, code `wfh_weekly_days`). The week runs Monday to Sunday. The quota resets every week and
 * is never carried over: nothing is stored, a week's usage is computed from the requests that fall in it.
 * Employees may file only while the allowance is above zero, and the days a request asks for in each week
 * must not exceed what remains of that week.
 *
 * WHAT COUNTS AS USED. Working days of requests that are pending or approved. A pending request is counted
 * so that filing several at once cannot overshoot the quota; a rejected, cancelled or expired one gives its
 * days back. Weekends and public holidays are never counted, the same arithmetic the request itself uses.
 */
@Injectable()
export class WfhQuotaService {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  /**
   * Looks up the weekly allowance an employee's rank gives them.
   *
   * Args:
   *   employeeId: The employee.
   *   executor: Database handle to read through, so the read joins the caller's transaction.
   *
   * Returns:
   *   The `wfh_weekly_days` benefit of the rank of the employee's current role, or
   *   `WFH_WEEKLY_DAYS_WITHOUT_BENEFIT` when they hold no ranked role or the rank has no such benefit.
   */
  async weeklyAllowanceFor(employeeId: string, executor?: DbExecutor): Promise<number> {
    const [row] = await (executor ?? this.db)
      .select({ allowance: rankBenefits.value })
      .from(employeeRoles)
      .innerJoin(roles, eq(roles.id, employeeRoles.roleId))
      .innerJoin(
        rankBenefits,
        and(
          eq(rankBenefits.rankId, roles.rankId),
          eq(rankBenefits.benefitCode, RANK_BENEFIT_CODE.WFH_WEEKLY_DAYS),
        ),
      )
      .where(and(eq(employeeRoles.employeeId, employeeId), isNull(employeeRoles.effectiveTo)))
      .limit(1);
    return row?.allowance ?? WFH_WEEKLY_DAYS_WITHOUT_BENEFIT;
  }

  /**
   * Reads an employee's quota for the week containing a date.
   *
   * Args:
   *   employeeId: The employee.
   *   dateInWeek: Any `YYYY-MM-DD` date in the wanted week; defaults to today in Asia/Ho_Chi_Minh.
   *
   * Returns:
   *   The week's allowance, the days already claimed and the days remaining.
   */
  async getWeekQuota(employeeId: string, dateInWeek?: string): Promise<WfhWeekQuota> {
    const weekStart = weekStartOf(dateInWeek ?? this.todayInHoChiMinh());
    const [weeklyAllowance, usedByWeek] = await Promise.all([
      this.weeklyAllowanceFor(employeeId),
      this.claimedDaysPerWeek(employeeId, [weekStart]),
    ]);
    const usedDays = usedByWeek.get(weekStart) ?? 0;
    return {
      weekStart,
      weekEnd: weekEndOf(weekStart),
      weeklyAllowance,
      usedDays,
      remainingDays: Math.max(0, weeklyAllowance - usedDays),
    };
  }

  /**
   * Refuses a request that the employee's quota cannot cover.
   *
   * Args:
   *   employeeId: The employee filing the request.
   *   requestedWorkingDates: The working days the request would cover, `YYYY-MM-DD`.
   *   executor: Database handle to read through; pass the transaction that will insert the request, taken
   *     under the per-employee lock, so two concurrent requests cannot both pass.
   *
   * Raises:
   *   PreconditionFailedException: `WFH_QUOTA_NONE` when the allowance is zero, or `WFH_QUOTA_EXCEEDED`
   *     when some week asks for more days than it has left.
   */
  async assertWithinQuota(
    employeeId: string,
    requestedWorkingDates: readonly string[],
    executor?: DbExecutor,
  ): Promise<void> {
    const weeklyAllowance = await this.weeklyAllowanceFor(employeeId, executor);
    if (weeklyAllowance <= 0) {
      throw new PreconditionFailedException(
        ErrorCodes.WFH_QUOTA_NONE,
        'Your rank has no work-from-home allowance, so a request cannot be filed',
      );
    }

    const requestedByWeek = countDatesPerWeek(requestedWorkingDates);
    const claimedByWeek = await this.claimedDaysPerWeek(
      employeeId,
      [...requestedByWeek.keys()],
      executor,
    );
    for (const [weekStart, requestedDays] of requestedByWeek) {
      const remainingDays = Math.max(0, weeklyAllowance - (claimedByWeek.get(weekStart) ?? 0));
      if (requestedDays > remainingDays) {
        throw new PreconditionFailedException(
          ErrorCodes.WFH_QUOTA_EXCEEDED,
          `Week of ${weekStart}: ${requestedDays} day(s) requested but ${remainingDays} left ` +
            `of ${weeklyAllowance}`,
        );
      }
    }
  }

  /**
   * Counts the working days already claimed in each of the given weeks.
   *
   * Args:
   *   employeeId: The employee.
   *   weekStarts: The Mondays of the weeks to count.
   *   executor: Database handle to read through.
   *
   * Returns:
   *   A map from each week's Monday to the working days pending and approved requests cover in it; a
   *   week with none has no entry.
   */
  private async claimedDaysPerWeek(
    employeeId: string,
    weekStarts: readonly string[],
    executor?: DbExecutor,
  ): Promise<Map<string, number>> {
    const sortedWeekStarts = [...weekStarts].sort();
    const rangeStart = sortedWeekStarts[0];
    const rangeEnd = weekEndOf(sortedWeekStarts[sortedWeekStarts.length - 1]);

    const claimingRequests = await (executor ?? this.db)
      .select({ workingDates: wfhRequests.workingDates })
      .from(wfhRequests)
      .where(
        and(
          eq(wfhRequests.employeeId, employeeId),
          inArray(wfhRequests.status, [..._QUOTA_CLAIMING_STATUSES]),
          lte(wfhRequests.startDate, rangeEnd),
          gte(wfhRequests.endDate, rangeStart),
        ),
      );
    // The days frozen on each request at submit, not the days between its dates under today's holiday
    // calendar: declaring a holiday later must not change what a request already claimed.
    const claimedDates = claimingRequests.flatMap((request) =>
      request.workingDates.filter((date) => date >= rangeStart && date <= rangeEnd),
    );
    const wantedWeeks = new Set(weekStarts);
    const claimedPerWeek = countDatesPerWeek(claimedDates);
    return new Map([...claimedPerWeek].filter(([weekStart]) => wantedWeeks.has(weekStart)));
  }

  /** Today's date in Asia/Ho_Chi_Minh, as `YYYY-MM-DD`. */
  private todayInHoChiMinh(): string {
    const shiftedMilliseconds = Date.now() + HO_CHI_MINH_UTC_OFFSET_HOURS * 3_600_000;
    return new Date(shiftedMilliseconds).toISOString().slice(0, 10);
  }
}
