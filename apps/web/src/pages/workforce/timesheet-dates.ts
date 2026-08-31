/**
 * Calendar and chunking arithmetic for bulk timesheet logging — pure functions, no components.
 *
 * Its own module for the reason `duration.ts` next door is: the modal exports components, and a
 * plain function mixed into a component file breaks Fast Refresh — eslint's
 * `react-refresh/only-export-components` said so. It also puts the EXPANSION RULE somewhere a test
 * can pin without rendering a form: one entry per day, every day in the range, weekends included.
 *
 * THE WEEKEND DECISION, recorded here because it is a product decision made twice otherwise. The
 * app has no client-side working-days helper — `working_days` on leave is computed server-side,
 * and the timesheet bulk endpoint deliberately takes one entry per day with no notion of a
 * calendar. So a range expands to EVERY day in it, and the person logging decides: the recurring
 * mode is where weekday skipping lives, as an explicit choice of chips rather than a silent
 * rule that assumes a Monday-to-Friday week.
 *
 * Dates are handled BY PARTS, as everywhere in the app — `new Date('2026-03-04')` is UTC midnight,
 * the exact bug `@/shared/lib/format.ts` and `shared/ui/date-grid.ts` exist for.
 */
import { parseIso, toIso } from '@/shared/ui/date-grid';

/** What the bulk endpoint takes per entry — the single-create body, `employeeId` excluded. */
export interface TimesheetDraft {
  workDate: string;
  minutesWorked: number;
  note?: string;
}

/** The bulk endpoint's ceiling (`BulkCreateTimesheetsSchema`: `z.array(...).max(50)`). */
export const BULK_MAX_ENTRIES = 50;

/**
 * Clock minutes between two `HH:mm` times, overnight-aware: `22:00 → 06:00` is 480, not negative.
 *
 * The same rule the API's `spanMinutes` applies — `end < start` is a shift that crossed midnight,
 * `workDate` being the day it STARTED — so the readout on a form and the number the API derives can
 * never disagree. The one refused case is `end === start`, which the modal reports rather than
 * sending: a zero-minute shift is a typo, and the backend's answer to it is a 422.
 */
export function minutesBetweenTimes(start: string, end: string): number {
  const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  return (minutesOf(end) - minutesOf(start) + 1440) % 1440;
}

/** True when both fields hold a complete `HH:mm` pair — the only shape the API accepts. */
export function isCompleteTimePair(startTime: string, endTime: string): boolean {
  return /^\d{2}:\d{2}$/.test(startTime) && /^\d{2}:\d{2}$/.test(endTime);
}

/**
 * Every day in an inclusive `DateRange`, in order.
 *
 * Local `Date` arithmetic normalises across month and DST boundaries by calendar
 * (`new Date(y, m, d + 1)`), so a range spanning a spring-forward night still lands on every date.
 */
export function expandDates(range: { from: string; to: string }): string[] {
  const dates: string[] = [];
  let cursor = range.from;
  while (cursor <= range.to) {
    dates.push(cursor);
    const { y, m, d } = parseIso(cursor)!;
    cursor = toIso(new Date(y, m - 1, d + 1));
  }
  return dates;
}

/**
 * The days of `dates` whose ISO weekday (Mon = 1 … Sun = 7) is one of `weekdays`.
 *
 * The weekday numbers are what a `getDay()`-based check produces — `(day + 6) % 7 + 1` — so the
 * chips' labels and the filter cannot disagree about which number means Monday.
 */
export function onWeekdays(dates: string[], weekdays: number[]): string[] {
  return dates.filter((iso) => {
    const { y, m, d } = parseIso(iso)!;
    return weekdays.includes(((new Date(y, m - 1, d).getDay() + 6) % 7) + 1);
  });
}

/**
 * Drafts for a whole window: one per day, the same duration and note each, nothing skipped.
 * Order is date order, which is the order the batches are sent and reported in.
 */
export function expandToDrafts(
  dates: string[],
  minutesWorked: number,
  note?: string,
): TimesheetDraft[] {
  return dates.map((workDate) => ({ workDate, minutesWorked, note }));
}

/**
 * Split drafts into batches the endpoint accepts — sequential, date-ordered, all but the last
 * exactly `BULK_MAX_ENTRIES`. One batch is one request and one failure unit: a batch that is
 * refused is reported by its date span, so the person retrying knows which days to re-log.
 */
export function chunkDrafts(drafts: TimesheetDraft[]): TimesheetDraft[][] {
  const batches: TimesheetDraft[][] = [];
  for (let start = 0; start < drafts.length; start += BULK_MAX_ENTRIES) {
    batches.push(drafts.slice(start, start + BULK_MAX_ENTRIES));
  }
  return batches;
}
