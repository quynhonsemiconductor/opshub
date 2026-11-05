import { describe, expect, it } from 'vitest';
import {
  benefitsWithWfhWeeklyDays,
  parseWfhWeeklyDays,
  wfhWeeklyDaysOf,
} from './rank-benefits.helpers';

const _RANK_WITH_ALLOWANCE = { benefits: [{ benefitCode: 'wfh_weekly_days', value: 2 }] };
const _RANK_WITHOUT_BENEFITS = { benefits: [] };

describe('wfhWeeklyDaysOf', () => {
  it('reads the allowance of a rank that has one', () => {
    expect(wfhWeeklyDaysOf(_RANK_WITH_ALLOWANCE)).toBe(2);
  });

  it('is null for a rank with no such benefit, which is not the same as zero', () => {
    expect(wfhWeeklyDaysOf(_RANK_WITHOUT_BENEFITS)).toBeNull();
    expect(wfhWeeklyDaysOf({ benefits: [{ benefitCode: 'wfh_weekly_days', value: 0 }] })).toBe(0);
  });
});

describe('benefitsWithWfhWeeklyDays', () => {
  it('sets the allowance on a rank that had none', () => {
    expect(benefitsWithWfhWeeklyDays(_RANK_WITHOUT_BENEFITS, 3)).toEqual([
      { benefitCode: 'wfh_weekly_days', value: 3 },
    ]);
  });

  it('replaces an existing allowance instead of listing it twice', () => {
    expect(benefitsWithWfhWeeklyDays(_RANK_WITH_ALLOWANCE, 4)).toEqual([
      { benefitCode: 'wfh_weekly_days', value: 4 },
    ]);
  });

  it('removes the benefit when the allowance is cleared', () => {
    expect(benefitsWithWfhWeeklyDays(_RANK_WITH_ALLOWANCE, null)).toEqual([]);
  });
});

describe('parseWfhWeeklyDays', () => {
  it('treats an empty field as no allowance set', () => {
    expect(parseWfhWeeklyDays('  ', 7)).toEqual({ ok: true, value: null });
  });

  it('accepts zero and whole numbers up to the maximum', () => {
    expect(parseWfhWeeklyDays('0', 7)).toEqual({ ok: true, value: 0 });
    expect(parseWfhWeeklyDays('7', 7)).toEqual({ ok: true, value: 7 });
  });

  it('refuses a number above the maximum, a fraction and a negative', () => {
    expect(parseWfhWeeklyDays('8', 7)).toMatchObject({ ok: false });
    expect(parseWfhWeeklyDays('1.5', 7)).toMatchObject({ ok: false });
    expect(parseWfhWeeklyDays('-1', 7)).toMatchObject({ ok: false });
  });
});
