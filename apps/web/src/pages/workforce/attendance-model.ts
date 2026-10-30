import type { components } from '@/shared/api/generated/api';

export type AttendanceMonthResponse = components['schemas']['AttendanceMonthResponseDto'];
export type AttendanceDay = components['schemas']['AttendanceDayDto'];
export type EmployeeAttendanceMonth = components['schemas']['EmployeeAttendanceMonthDto'];
export type JustificationKind = components['schemas']['CreateJustificationDto']['kind'];

/**
 * Pure helpers behind the Attendance tab — no React, no clock reads.
 *
 * The day rules themselves live in the API (`attendance-day.ts` there is the exhaustive spec);
 * what lives here is presentation: the English labels, and the per-employee month totals the
 * summary table shows.
 */

/** Status words, as the rules name them. */
export const STATUS_LABEL: Record<AttendanceDay['status'], string> = {
  holiday: 'Public holiday',
  leave: 'On leave',
  wfh: 'Work from home',
  office: 'Office',
  absent: 'Unexcused absence',
};

export const FLAG_LABEL: Record<AttendanceDay['flags'][number], string> = {
  late: 'Late',
  early: 'Left early',
  missing_checkout: 'Missed check-out',
  absent: 'Unexcused absence',
  unsynced: 'Device time not synced',
};

/** The kinds a justification can repair, in the order the picker offers them. */
export const JUSTIFICATION_KINDS: { value: JustificationKind; label: string }[] = [
  { value: 'late', label: 'Late' },
  { value: 'early', label: 'Left early' },
  { value: 'forgot_card', label: 'Forgot card' },
  { value: 'missing_checkout', label: 'Missed check-out' },
];

export interface EmployeeTotals {
  officeDays: number;
  wfhDays: number;
  leaveDays: number;
  absences: number;
  lateCount: number;
  earlyCount: number;
  hours: number;
}

/** The month's per-employee numbers, matching the summary CSV's columns. */
export function totalsFor(employee: EmployeeAttendanceMonth): EmployeeTotals {
  const t: EmployeeTotals = {
    officeDays: 0,
    wfhDays: 0,
    leaveDays: 0,
    absences: 0,
    lateCount: 0,
    earlyCount: 0,
    hours: 0,
  };
  for (const day of employee.days) {
    // Halves count half — the table must add up to the month's working days (matches the CSV).
    const whole = day.leavePortion === 'morning' || day.leavePortion === 'afternoon' ? 0.5 : 1;
    // Leave counts by leaveType (a half-day is status `office` with a leave type), so the leave
    // column and the office column split a half-day instead of double-counting it.
    if (day.leaveType) t.leaveDays += whole;
    if (day.status === 'office') t.officeDays += whole;
    else if (day.status === 'wfh') t.wfhDays += whole;
    else if (day.status === 'absent') t.absences += whole;
    if (day.flags.includes('late')) t.lateCount += 1;
    if (day.flags.includes('early')) t.earlyCount += 1;
    t.hours += day.workedMinutes / 60;
  }
  return t;
}

/** `HH:MM` from minutes, for the worked-hours column ("7.5" reads worse than "7:30"). */
export function hoursLabel(totalHours: number): string {
  const whole = Math.floor(totalHours);
  const minutes = Math.round((totalHours - whole) * 60);
  return `${whole}:${String(minutes).padStart(2, '0')}`;
}
