import { describe, expect, it } from 'vitest';
import { hoursLabel, totalsFor, STATUS_LABEL, FLAG_LABEL } from './attendance-model';
import type { EmployeeAttendanceMonth } from './attendance-model';

const DAY = {
  lateMinutes: null,
  earlyMinutes: null,
  flags: [] as EmployeeAttendanceMonth['days'][number]['flags'],
  pendingJustification: false,
  leaveType: null,
  leavePortion: null,
};

const employee: EmployeeAttendanceMonth = {
  id: 'e1',
  name: 'An',
  department: 'IT',
  days: [
    { ...DAY, date: '2026-10-05', status: 'office', workedMinutes: 480 },
    { ...DAY, date: '2026-10-06', status: 'wfh', workedMinutes: 480 },
    { ...DAY, date: '2026-10-07', status: 'leave', workedMinutes: 0, leaveType: 'annual' },
    { ...DAY, date: '2026-10-08', status: 'absent', workedMinutes: 0, flags: ['absent'] },
    {
      ...DAY,
      date: '2026-10-09',
      status: 'office',
      workedMinutes: 450,
      lateMinutes: 30,
      flags: ['late'],
    },
    {
      ...DAY,
      date: '2026-10-12',
      status: 'office',
      workedMinutes: 420,
      earlyMinutes: 60,
      flags: ['early'],
    },
    // A morning of leave, worked the afternoon: 0.5 office, 0.5 annual.
    {
      ...DAY,
      date: '2026-10-13',
      status: 'office',
      workedMinutes: 240,
      leaveType: 'annual',
      leavePortion: 'morning',
    },
  ],
};

describe('totalsFor', () => {
  it('counts the month the way the summary CSV does', () => {
    // The half-day row adds 0.5 office and 0.5 annual leave: the month adds up.
    expect(totalsFor(employee)).toEqual({
      officeDays: 3.5,
      wfhDays: 1,
      leaveDays: 1.5,
      absences: 1,
      lateCount: 1,
      earlyCount: 1,
      hours: (480 + 480 + 450 + 420 + 240) / 60,
    });
  });
  it('an empty month is zeros, not NaN', () => {
    const t = totalsFor({ id: 'e2', name: 'Binh', department: null, days: [] });
    expect(t.hours).toBe(0);
    expect(t.absences).toBe(0);
    expect(Number.isNaN(t.officeDays)).toBe(false);
  });
});

describe('hoursLabel', () => {
  it('reads as hours and minutes', () => {
    expect(hoursLabel(8)).toBe('8:00');
    expect(hoursLabel(30.5)).toBe('30:30');
    expect(hoursLabel(7.25)).toBe('7:15');
  });
});

describe('the Vietnamese label maps cover every value the API can send', () => {
  it('has a status word for all five statuses', () => {
    expect(Object.keys(STATUS_LABEL).sort()).toEqual(
      ['absent', 'holiday', 'leave', 'office', 'wfh'].sort(),
    );
  });
  it('has a flag word for all five flags', () => {
    expect(Object.keys(FLAG_LABEL).sort()).toEqual(
      ['absent', 'early', 'late', 'missing_checkout', 'unsynced'].sort(),
    );
  });
});
