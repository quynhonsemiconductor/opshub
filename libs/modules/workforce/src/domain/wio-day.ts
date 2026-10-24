import { addDays, today } from '@shared-kernel';

/** How far ahead a day can be marked. */
export const MAX_DAYS_AHEAD = 366;

/** Last day of a `YYYY-MM` month, as `YYYY-MM-DD`. Day 0 of the next month is the last of this one. */
export function lastDayOf(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/**
 * Why a day cannot be marked, or null when it can.
 *
 * "Past" is judged against YESTERDAY in UTC, not today: the date came from a person's own calendar, and
 * at 01:00 in UTC+7 their today is already tomorrow in UTC. Comparing against UTC today would refuse a
 * person marking the day they are standing in (the trap `latestDateAnywhere` documents).
 *
 * Takes `now` so a test can fix the clock instead of mocking `Date`.
 */
export function wioDayProblem(date: string, now: Date = new Date()): string | null {
  if (date < addDays(today(now), -1)) return 'A day that has already passed cannot be changed';
  // One year ahead is plenty for planning; no bound would let one caller write rows for 9999-12-31.
  if (date > addDays(today(now), MAX_DAYS_AHEAD)) return 'That day is too far ahead to plan';
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (weekday === 0 || weekday === 6) {
    return 'Weekends are not working days, so there is nothing to mark';
  }
  return null;
}
