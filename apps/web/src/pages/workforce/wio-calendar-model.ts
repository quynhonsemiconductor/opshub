import { parseIso } from '@/shared/ui/date-grid';
import type { components } from '@/shared/api/generated/api';

export type WioMonth = components['schemas']['WioMonthResponseDto'];
export type WioPerson = components['schemas']['WioPersonDto'];
export type PtoPortion = components['schemas']['WioPtoDto']['portion'];

/**
 * Pure helpers behind the WIO calendar — no React, no dates read from the clock, so a test fixes "today".
 *
 * The data model is "who works from home"; being in the office is the ABSENCE of a mark. So a day's
 * office list is never stored or fetched, it is everyone minus that day's marks.
 */

/** `YYYY-MM` for a calendar month; `m` is zero-based like `Date`. */
export function monthKey(view: { y: number; m: number }): string {
  return `${view.y}-${String(view.m + 1).padStart(2, '0')}`;
}

/** The month before or after `view`, rolling the year. */
export function shiftMonth(view: { y: number; m: number }, by: 1 | -1): { y: number; m: number } {
  const d = new Date(view.y, view.m + by, 1);
  return { y: d.getFullYear(), m: d.getMonth() };
}

/** Monday to Friday. Weekends are not working days, so they carry no marks and no counts. */
export function isWorkday(iso: string): boolean {
  const p = parseIso(iso);
  if (!p) return false;
  const weekday = new Date(p.y, p.m - 1, p.d).getDay();
  return weekday !== 0 && weekday !== 6;
}

/** Whether the signed-in person may change `iso`: a working day that is today or later. */
export function isEditable(iso: string, todayIso: string): boolean {
  return isWorkday(iso) && iso >= todayIso;
}

/** A month's marks, indexed by date so each of the ~30 day cells reads its people without rescanning. */
export interface MonthIndex {
  /** date → ids working from home */
  wfh: Map<string, Set<string>>;
  /** date → id → how much of that day is approved leave */
  pto: Map<string, Map<string, PtoPortion>>;
}

export function indexMonth(month: WioMonth | undefined): MonthIndex {
  const wfh = new Map<string, Set<string>>();
  for (const mark of month?.wfh ?? []) {
    const ids = wfh.get(mark.date) ?? new Set<string>();
    ids.add(mark.employeeId);
    wfh.set(mark.date, ids);
  }
  const pto = new Map<string, Map<string, PtoPortion>>();
  for (const mark of month?.pto ?? []) {
    const byId = pto.get(mark.date) ?? new Map<string, PtoPortion>();
    byId.set(mark.employeeId, mark.portion);
    pto.set(mark.date, byId);
  }
  return { wfh, pto };
}

export interface DaySummary {
  wfh: WioPerson[];
  office: WioPerson[];
  /** On leave for the WHOLE day. A half-day of leave leaves the person in `wfh` or `office` instead. */
  pto: WioPerson[];
  /** People who are away for half of the day and so still appear in `wfh` or `office`. */
  partial: Map<string, Exclude<PtoPortion, 'full_day'>>;
}

/**
 * Where everyone is on `iso`. A day of approved leave wins over a WFH mark: somebody on leave is not
 * working from home. Half a day of leave does not remove the person from the office or WFH list, since
 * they are working the other half; it is reported in `partial` so the list can say which half is off.
 */
export function summariseDay(iso: string, people: WioPerson[], index: MonthIndex): DaySummary {
  const away = index.wfh.get(iso);
  const leave = index.pto.get(iso);
  const summary: DaySummary = { wfh: [], office: [], pto: [], partial: new Map() };
  for (const person of people) {
    const portion = leave?.get(person.id);
    if (portion === 'full_day') {
      summary.pto.push(person);
      continue;
    }
    (away?.has(person.id) ? summary.wfh : summary.office).push(person);
    if (portion) summary.partial.set(person.id, portion);
  }
  return summary;
}

/** The same month with `employeeId`'s mark on `iso` set or cleared — what an optimistic update writes. */
export function withMark(month: WioMonth, iso: string, employeeId: string, wfh: boolean): WioMonth {
  const others = month.wfh.filter((m) => !(m.date === iso && m.employeeId === employeeId));
  return { ...month, wfh: wfh ? [...others, { employeeId, date: iso }] : others };
}
