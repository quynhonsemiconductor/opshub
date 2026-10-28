import { describe, expect, it } from 'vitest';
import { monthInstantBounds } from './attendance.service';

/**
 * The SQL-side bounds the events query judges its window on. December was `YYYY-13` — an invalid
 * month that matched nothing, so no December event ever reached the view — and the HCM boundary
 * decides which local day a UTC instant belongs to: 17:00Z is midnight in UTC+7, so an event at
 * 16:59:59Z is YESTERDAY's day and one at 17:00:00Z is today's.
 */
describe('monthInstantBounds', () => {
  it('bounds a mid-year month', () => {
    const [start, end] = monthInstantBounds('2026-10');
    expect(start.toISOString()).toBe('2026-09-30T17:00:00.000Z'); // Oct 1 00:00 HCM
    expect(end.toISOString()).toBe('2026-10-31T17:00:00.000Z'); // Nov 1 00:00 HCM
  });

  it('rolls the YEAR in December — no "2026-13"', () => {
    const [start, end] = monthInstantBounds('2026-12');
    expect(start.toISOString()).toBe('2026-11-30T17:00:00.000Z');
    expect(end.toISOString()).toBe('2026-12-31T17:00:00.000Z'); // Jan 1 2027 00:00 HCM
  });

  it('puts the 17:00Z midnight boundary on the local side of it', () => {
    const [start] = monthInstantBounds('2026-10');
    // 16:59:59Z on Sep 30 is one millisecond BEFORE the window; 17:00:00Z exactly on it.
    expect(new Date('2026-09-30T16:59:59.999Z') < start).toBe(true);
    expect(start <= new Date('2026-09-30T17:00:00.000Z')).toBe(true);
  });
});
