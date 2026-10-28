import { describe, expect, it } from 'vitest';
import { lastDayOf } from './wio-day';

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
