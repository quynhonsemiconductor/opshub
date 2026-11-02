import { describe, expect, it } from 'vitest';
import { countDatesPerWeek, weekEndOf, weekStartOf } from './wfh-week.helper';

// 2026-11-02 is a Monday, so 2026-11-02 … 2026-11-08 is one week and 2026-11-09 starts the next.
const _MONDAY = '2026-11-02';
const _SUNDAY = '2026-11-08';
const _NEXT_MONDAY = '2026-11-09';

describe('weekStartOf', () => {
  it('returns a Monday as itself', () => {
    expect(weekStartOf(_MONDAY)).toBe(_MONDAY);
  });

  it('returns the Monday before a mid-week date', () => {
    expect(weekStartOf('2026-11-05')).toBe(_MONDAY);
  });

  it('keeps Sunday in the week that began the Monday before, not the week after', () => {
    expect(weekStartOf(_SUNDAY)).toBe(_MONDAY);
  });

  it('crosses a month boundary', () => {
    expect(weekStartOf('2026-12-01')).toBe('2026-11-30');
  });
});

describe('weekEndOf', () => {
  it('returns the Sunday of the week', () => {
    expect(weekEndOf(_MONDAY)).toBe(_SUNDAY);
  });
});

describe('countDatesPerWeek', () => {
  it('splits dates across the weeks they fall in', () => {
    const counts = countDatesPerWeek(['2026-11-05', '2026-11-06', _NEXT_MONDAY]);
    expect(Object.fromEntries(counts)).toEqual({ [_MONDAY]: 2, [_NEXT_MONDAY]: 1 });
  });

  it('is empty for no dates', () => {
    expect(countDatesPerWeek([]).size).toBe(0);
  });
});
