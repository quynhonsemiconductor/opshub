import { parseIso } from '@/shared/ui/date-grid';
import type { components } from '@/shared/api/generated/api';

export type WioMonth = components['schemas']['WioMonthResponseDto'];
export type WioPerson = components['schemas']['WioPersonDto'];
export type PtoPortion = components['schemas']['WioPtoDto']['portion'];

/**
 * Pure helpers behind the WIO calendar — no React, no dates read from the clock, so a test fixes "today".
 *
 * The data model is "who works from home"; being in the office is the ABSENCE of a mark. Since WFH
 * became a manager-approved request (rules 2026-10-28), a mark carries a status: `approved` counts,
 * `pending` is shown as asked-for-but-not-answered. Public holidays are marks of a different kind —
 * a day nobody is expected in.
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

/** A month's marks, indexed by date so each of the ~30 day cells reads its people without rescanning. */
export interface MonthIndex {
  /** date → id → whether the WFH request covering that day is approved or still pending */
  wfh: Map<string, Map<string, 'approved' | 'pending'>>;
  /** date → id → how much of that day is approved leave */
  pto: Map<string, Map<string, PtoPortion>>;
  /** date → holiday name. A holiday day has nobody expected in, whatever the marks say. */
  holidays: Map<string, string>;
}

export function indexMonth(month: WioMonth | undefined): MonthIndex {
  const wfh = new Map<string, Map<string, 'approved' | 'pending'>>();
  for (const mark of month?.wfh ?? []) {
    const byId = wfh.get(mark.date) ?? new Map<string, 'approved' | 'pending'>();
    // An approved request outranks a pending one on the same day (submit refuses the overlap; this
    // is the same defence the API applies, kept in step here).
    if (byId.get(mark.employeeId) !== 'approved') byId.set(mark.employeeId, mark.status);
    wfh.set(mark.date, byId);
  }
  const pto = new Map<string, Map<string, PtoPortion>>();
  for (const mark of month?.pto ?? []) {
    const byId = pto.get(mark.date) ?? new Map<string, PtoPortion>();
    byId.set(mark.employeeId, mark.portion);
    pto.set(mark.date, byId);
  }
  const holidays = new Map<string, string>();
  for (const holiday of month?.holidays ?? []) holidays.set(holiday.date, holiday.name);
  return { wfh, pto, holidays };
}

export interface DaySummary {
  /** WFH the manager signed off. */
  wfh: WioPerson[];
  /** WFH asked for but not answered yet. */
  pendingWfh: WioPerson[];
  office: WioPerson[];
  /** On leave for the WHOLE day. A half-day of leave leaves the person in `wfh`, `pendingWfh` or `office` instead. */
  pto: WioPerson[];
  /** People who are away for half of the day and so still appear in `wfh`, `pendingWfh` or `office`. */
  partial: Map<string, Exclude<PtoPortion, 'full_day'>>;
}

/**
 * Where everyone is on `iso`. Precedence, the same ladder the API applies: an approved full day of
 * leave wins over a WFH mark (somebody on leave is not working from home); a WFH mark wins over the
 * office default. A PENDING WFH mark is not a WFH day yet — the person sits in neither list, but in
 * `pendingWfh`, because the manager may still say no and the calendar must not read the day as settled.
 */
export function summariseDay(iso: string, people: WioPerson[], index: MonthIndex): DaySummary {
  const wfhIds = index.wfh.get(iso);
  const leave = index.pto.get(iso);
  const summary: DaySummary = { wfh: [], pendingWfh: [], office: [], pto: [], partial: new Map() };
  for (const person of people) {
    const portion = leave?.get(person.id);
    if (portion === 'full_day') {
      summary.pto.push(person);
      continue;
    }
    const mark = wfhIds?.get(person.id);
    if (mark === 'approved') summary.wfh.push(person);
    else if (mark === 'pending') summary.pendingWfh.push(person);
    else summary.office.push(person);
    if (portion) summary.partial.set(person.id, portion);
  }
  return summary;
}
