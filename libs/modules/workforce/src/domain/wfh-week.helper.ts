import { isoWeekday } from './working-days';

/** Milliseconds in one calendar day; WFH weeks run on calendar dates, so no daylight saving applies. */
const _MILLISECONDS_PER_DAY = 86_400_000;

/** Days between a week's Monday and its Sunday. */
const _DAYS_FROM_MONDAY_TO_SUNDAY = 6;

/**
 * Adds a number of days to a calendar date.
 *
 * Args:
 *   date: A `YYYY-MM-DD` date.
 *   days: How many days to add; negative moves back.
 *
 * Returns:
 *   The resulting `YYYY-MM-DD` date.
 */
function _addDays(date: string, days: number): string {
  const shiftedMilliseconds =
    new Date(`${date}T00:00:00Z`).getTime() + days * _MILLISECONDS_PER_DAY;
  return new Date(shiftedMilliseconds).toISOString().slice(0, 10);
}

/**
 * Finds the Monday of the Monday–Sunday week a date falls in.
 *
 * Args:
 *   date: A `YYYY-MM-DD` date.
 *
 * Returns:
 *   The `YYYY-MM-DD` date of that week's Monday (the date itself when it is a Monday).
 */
export function weekStartOf(date: string): string {
  return _addDays(date, -(isoWeekday(date) - 1));
}

/**
 * Finds the Sunday of the week that starts on the given Monday.
 *
 * Args:
 *   weekStart: The `YYYY-MM-DD` date of a Monday, as returned by {@link weekStartOf}.
 *
 * Returns:
 *   The `YYYY-MM-DD` date of that week's Sunday.
 */
export function weekEndOf(weekStart: string): string {
  return _addDays(weekStart, _DAYS_FROM_MONDAY_TO_SUNDAY);
}

/**
 * Counts how many of the given dates fall in each Monday–Sunday week.
 *
 * Args:
 *   dates: `YYYY-MM-DD` dates, in any order; duplicates are counted as given.
 *
 * Returns:
 *   A map from a week's Monday to the number of dates in that week, in the order weeks first appear.
 */
export function countDatesPerWeek(dates: readonly string[]): Map<string, number> {
  const countsByWeekStart = new Map<string, number>();
  for (const date of dates) {
    const weekStart = weekStartOf(date);
    countsByWeekStart.set(weekStart, (countsByWeekStart.get(weekStart) ?? 0) + 1);
  }
  return countsByWeekStart;
}
