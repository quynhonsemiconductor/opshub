import { datesInRange, isoWeekday, WORKING_WEEKDAYS } from './working-days';
import type { LeaveDayPortion } from './workforce.types';

/**
 * Which part of a working day somebody is on approved leave, for the WIO calendar.
 *
 * A leave window runs from `startDate` at `startPortion` to `endDate` at `endPortion`, and only its two
 * END days can be part-day (see `leave-window.ts`): every day strictly between is a whole day. A
 * single-day window carries one portion, written identically in both fields.
 */
export interface PtoWindow {
  employeeId: string;
  startDate: string;
  endDate: string;
  startPortion: LeaveDayPortion;
  endPortion: LeaveDayPortion;
}

export interface PtoMark {
  employeeId: string;
  date: string;
  portion: LeaveDayPortion;
}

/** The portion of `date` a window covers, or null when the window does not reach it. */
export function portionOn(window: PtoWindow, date: string): LeaveDayPortion | null {
  if (date < window.startDate || date > window.endDate) return null;
  if (date === window.startDate) return window.startPortion;
  if (date === window.endDate) return window.endPortion;
  return 'full_day';
}

/**
 * One mark per person per WORKING day of `[from, to]` that any of `windows` covers.
 *
 * Weekends are skipped because the calendar draws no counts on them, and a long leave is clipped to the
 * month asked for so a three-month window costs thirty days of work, not ninety.
 *
 * If two windows cover the same day for one person (an approved request overlapping another is refused
 * on submit, so this is defence rather than expectation) the wider portion wins: `full_day` over a half.
 */
export function ptoMarksInRange(windows: PtoWindow[], from: string, to: string): PtoMark[] {
  const marks = new Map<string, PtoMark>();
  for (const window of windows) {
    const start = window.startDate > from ? window.startDate : from;
    const end = window.endDate < to ? window.endDate : to;
    if (end < start) continue;
    for (const date of datesInRange(start, end)) {
      if (!WORKING_WEEKDAYS.includes(isoWeekday(date))) continue;
      const portion = portionOn(window, date);
      if (!portion) continue;
      const key = `${window.employeeId}|${date}`;
      const existing = marks.get(key);
      if (!existing || portion === 'full_day') {
        marks.set(key, { employeeId: window.employeeId, date, portion });
      }
    }
  }
  return [...marks.values()];
}
