import { describe, expect, it } from 'vitest';
import { portionOn, ptoMarksInRange, type PtoWindow } from './wio-pto';

const win = (over: Partial<PtoWindow>): PtoWindow => ({
  employeeId: 'a',
  startDate: '2026-10-20',
  endDate: '2026-10-22',
  startPortion: 'full_day',
  endPortion: 'full_day',
  ...over,
});

describe('portionOn', () => {
  it('covers every day of a whole-day window and nothing outside it', () => {
    const w = win({});
    expect(portionOn(w, '2026-10-19')).toBeNull();
    expect(portionOn(w, '2026-10-20')).toBe('full_day');
    expect(portionOn(w, '2026-10-21')).toBe('full_day');
    expect(portionOn(w, '2026-10-22')).toBe('full_day');
    expect(portionOn(w, '2026-10-23')).toBeNull();
  });

  it('lets only the two end days be part-day', () => {
    const w = win({ startPortion: 'afternoon', endPortion: 'morning' });
    expect(portionOn(w, '2026-10-20')).toBe('afternoon');
    expect(portionOn(w, '2026-10-21')).toBe('full_day'); // strictly between: always whole
    expect(portionOn(w, '2026-10-22')).toBe('morning');
  });

  it('reads a single-day window by its one portion', () => {
    const w = win({
      startDate: '2026-10-21',
      endDate: '2026-10-21',
      startPortion: 'morning',
      endPortion: 'morning',
    });
    expect(portionOn(w, '2026-10-21')).toBe('morning');
  });
});

describe('ptoMarksInRange', () => {
  it('skips weekends, because the calendar draws nothing on them', () => {
    // Thu 22 Oct to Tue 27 Oct crosses a weekend (24th, 25th).
    const marks = ptoMarksInRange(
      [win({ startDate: '2026-10-22', endDate: '2026-10-27' })],
      '2026-10-01',
      '2026-10-31',
    );
    expect(marks.map((m) => m.date)).toEqual([
      '2026-10-22',
      '2026-10-23',
      '2026-10-26',
      '2026-10-27',
    ]);
  });

  it('clips a window that runs past the month to the month asked for', () => {
    const marks = ptoMarksInRange(
      [win({ startDate: '2026-10-29', endDate: '2026-11-04' })],
      '2026-10-01',
      '2026-10-31',
    );
    expect(marks.map((m) => m.date)).toEqual(['2026-10-29', '2026-10-30']);
    const next = ptoMarksInRange(
      [win({ startDate: '2026-10-29', endDate: '2026-11-04' })],
      '2026-11-01',
      '2026-11-30',
    );
    expect(next.map((m) => m.date)).toEqual(['2026-11-02', '2026-11-03', '2026-11-04']);
  });

  it('keeps the part-day portions on the end days', () => {
    const marks = ptoMarksInRange(
      [win({ startPortion: 'afternoon', endPortion: 'morning' })],
      '2026-10-01',
      '2026-10-31',
    );
    expect(marks.map((m) => m.portion)).toEqual(['afternoon', 'full_day', 'morning']);
  });

  it('returns nothing for a window outside the range', () => {
    expect(ptoMarksInRange([win({})], '2026-11-01', '2026-11-30')).toEqual([]);
  });

  it('keeps one mark per person per day, whole day beating a half', () => {
    const marks = ptoMarksInRange(
      [
        win({
          startDate: '2026-10-21',
          endDate: '2026-10-21',
          startPortion: 'morning',
          endPortion: 'morning',
        }),
        win({ startDate: '2026-10-21', endDate: '2026-10-21' }),
      ],
      '2026-10-01',
      '2026-10-31',
    );
    expect(marks).toEqual([{ employeeId: 'a', date: '2026-10-21', portion: 'full_day' }]);
  });

  it('keeps different people apart', () => {
    const marks = ptoMarksInRange(
      [
        win({ employeeId: 'a', endDate: '2026-10-20' }),
        win({ employeeId: 'b', endDate: '2026-10-20' }),
      ],
      '2026-10-01',
      '2026-10-31',
    );
    expect(marks.map((m) => m.employeeId).sort()).toEqual(['a', 'b']);
  });
});
