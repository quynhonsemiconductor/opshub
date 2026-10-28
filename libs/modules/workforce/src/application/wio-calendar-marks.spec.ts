import { describe, expect, it } from 'vitest';
import { wfhMarksInRange } from './wio-calendar.service';

/** Oct 2026: the 1st is a Thursday; the 3rd–4th a weekend. */
const HOLIDAYS = new Set(['2026-10-08']);

describe('wfhMarksInRange', () => {
  it('expands an approved window to its working days, clipped to the month', () => {
    const marks = wfhMarksInRange(
      [{ employeeId: 'a', startDate: '2026-09-28', endDate: '2026-10-07', status: 'approved' }],
      '2026-10-01',
      '2026-10-31',
      HOLIDAYS,
    );
    // Oct 1,2 (Thu,Fri), 5,6,7 (Mon–Wed) — weekend skipped, nothing before the month.
    expect(marks.map((m) => m.date)).toEqual([
      '2026-10-01',
      '2026-10-02',
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
    ]);
    expect(marks.every((m) => m.status === 'approved')).toBe(true);
  });

  it('skips the month public holidays — a holiday added after approval is not a WFH day', () => {
    const marks = wfhMarksInRange(
      [{ employeeId: 'a', startDate: '2026-10-05', endDate: '2026-10-09', status: 'approved' }],
      '2026-10-01',
      '2026-10-31',
      HOLIDAYS,
    );
    expect(marks.map((m) => m.date)).not.toContain('2026-10-08');
  });

  it('an approved window outranks a pending one on the same person and day', () => {
    const marks = wfhMarksInRange(
      [
        { employeeId: 'a', startDate: '2026-10-05', endDate: '2026-10-05', status: 'pending' },
        { employeeId: 'a', startDate: '2026-10-05', endDate: '2026-10-05', status: 'approved' },
      ],
      '2026-10-01',
      '2026-10-31',
      HOLIDAYS,
    );
    expect(marks).toEqual([{ employeeId: 'a', date: '2026-10-05', status: 'approved' }]);
  });

  it('drops employees nothing is known about is the caller’s job — a window wholly outside the month yields nothing', () => {
    expect(
      wfhMarksInRange(
        [{ employeeId: 'a', startDate: '2026-11-02', endDate: '2026-11-03', status: 'approved' }],
        '2026-10-01',
        '2026-10-31',
        HOLIDAYS,
      ),
    ).toEqual([]);
  });
});
