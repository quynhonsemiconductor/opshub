import { describe, expect, it } from 'vitest';
import { lastDayOf, wioDayProblem } from './wio-day';

// Wednesday 2026-10-21, 06:00 UTC (13:00 in Vietnam).
const NOW = new Date('2026-10-21T06:00:00Z');

describe('lastDayOf', () => {
  it.each([
    ['2026-10', '2026-10-31'],
    ['2026-02', '2026-02-28'],
    ['2028-02', '2028-02-29'], // leap year
    ['2026-12', '2026-12-31'],
    ['2026-04', '2026-04-30'],
  ])('%s ends on %s', (month, last) => {
    expect(lastDayOf(month)).toBe(last);
  });
});

describe('wioDayProblem', () => {
  it('lets a person mark today and any later weekday', () => {
    expect(wioDayProblem('2026-10-21', NOW)).toBeNull(); // today (Wed)
    expect(wioDayProblem('2026-10-22', NOW)).toBeNull(); // tomorrow (Thu)
    expect(wioDayProblem('2027-01-04', NOW)).toBeNull(); // months ahead (Mon)
  });

  it('refuses a day that has already passed', () => {
    expect(wioDayProblem('2026-10-19', NOW)).toMatch(/already passed/); // Monday, two days ago
    expect(wioDayProblem('2025-10-21', NOW)).toMatch(/already passed/);
  });

  it('still lets a person mark the day they are standing in just after local midnight', () => {
    // 00:30 on Thursday 22 Oct in UTC+7 is 17:30 UTC on Wednesday the 21st: UTC "today" is the 21st, but the
    // person's today is the 22nd. Yesterday-in-UTC is the cutoff, so both days stay open.
    const justAfterMidnightInVietnam = new Date('2026-10-21T17:30:00Z');
    expect(wioDayProblem('2026-10-22', justAfterMidnightInVietnam)).toBeNull();
    expect(wioDayProblem('2026-10-21', justAfterMidnightInVietnam)).toBeNull();
  });

  it('refuses a day more than a year ahead, and accepts the last one inside the limit', () => {
    expect(wioDayProblem('2027-10-22', NOW)).toBeNull(); // Friday, 366 days ahead
    expect(wioDayProblem('2027-10-25', NOW)).toMatch(/too far ahead/); // Monday, 369 days ahead
    expect(wioDayProblem('9999-12-31', NOW)).toMatch(/too far ahead/);
  });

  it('refuses weekends, even in the future', () => {
    expect(wioDayProblem('2026-10-24', NOW)).toMatch(/Weekends/); // Saturday
    expect(wioDayProblem('2026-10-25', NOW)).toMatch(/Weekends/); // Sunday
  });

  it('reports a past weekend as past, not as a weekend', () => {
    expect(wioDayProblem('2026-10-17', NOW)).toMatch(/already passed/); // Saturday last week
  });
});
