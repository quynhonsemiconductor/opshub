/**
 * Calendar arithmetic for `DateRangePicker` — pure functions over `YYYY-MM-DD` strings.
 *
 * Kept out of the component for the reason the README gives for helpers generally, and because a
 * grid the tests pin must be inert. THE ONE RULE HERE: dates are handled BY PARTS, never through the
 * timezone. `new Date('2026-03-04')` parses as UTC midnight and renders as the 3rd for anybody
 * behind UTC — the bug `@/shared/lib/format.ts` exists for — so every parse reads the string's parts
 * and every print writes them back, with local `Date` objects only as a calendar for the arithmetic
 * in between (`new Date(y, m, d + n)` normalizes by calendar, so a DST boundary cannot shift a day).
 *
 * Labels are FIXED English arrays for the same reason `format.ts` fixes its locale: a screenshot in
 * a bug report has to mean what the reporter's screen meant, and a test has to be indifferent to
 * the CI box's timezone. Monday-first, as that locale reads.
 */

/** An inclusive window, both ends `YYYY-MM-DD`. `from` is never after `to`. */
export interface DateRange {
  from: string;
  to: string;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Well-formed `YYYY-MM-DD` — shape only; `parseIso` additionally proves it is a real day. */
export function isWellFormedIso(iso: string): boolean {
  return ISO.test(iso);
}

export const MONTHS =
  'January February March April May June July August September October November December'.split(
    ' ',
  );
export const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

export function parseIso(iso: string): { y: number; m: number; d: number } | null {
  if (!ISO.test(iso)) return null;
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  // Round-trip: `2026-02-31` is built as March 3rd, which is not the date that was typed.
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d
    ? { y, m, d }
    : null;
}

export function toIso(date: Date): string {
  const part = (n: number) => `${n}`.padStart(2, '0');
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}`;
}

export function addDays(iso: string, days: number): string {
  const { y, m, d } = parseIso(iso)!;
  return toIso(new Date(y, m - 1, d + days));
}

/**
 * The AUTO-SWAP rule in one place: a range whose ends land out of order is emitted ORDERED, not
 * rejected. ISO strings compare chronologically, so `<` is the whole rule.
 */
export function orderRange(a: string, b: string): DateRange {
  return a <= b ? { from: a, to: b } : { from: b, to: a };
}

/** Six weeks of day cells covering the month — a fixed height, so the panel never jumps. */
export function monthCells(view: { y: number; m: number }): string[] {
  const lead = (new Date(view.y, view.m, 1).getDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, i) => toIso(new Date(view.y, view.m, i + 1 - lead)));
}

/** `4 March 2026` — the accessible name of a day, spoken from parts. */
export function dayName(iso: string): string {
  return `${Number(iso.slice(8))} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
}
