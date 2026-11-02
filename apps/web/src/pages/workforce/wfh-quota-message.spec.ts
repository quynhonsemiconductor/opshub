import { describe, expect, it } from 'vitest';
import { describeWfhQuota, fitsWfhQuota, type WfhQuota } from './wfh-quota-message';

function quota(overrides: Partial<WfhQuota> = {}): WfhQuota {
  return {
    weekStart: '2026-11-02',
    weekEnd: '2026-11-08',
    weeklyAllowance: 2,
    usedDays: 1,
    remainingDays: 1,
    ...overrides,
  };
}

describe('describeWfhQuota', () => {
  it('says nothing while the quota is loading', () => {
    expect(describeWfhQuota(undefined)).toBeNull();
  });

  it('reports the days left of the allowance, singular for one', () => {
    expect(describeWfhQuota(quota())).toBe('Week of 2026-11-02: 1 day left of 2.');
  });

  it('uses the plural for several days or none', () => {
    expect(describeWfhQuota(quota({ remainingDays: 2, usedDays: 0 }))).toContain('2 days left');
    expect(describeWfhQuota(quota({ remainingDays: 0, usedDays: 2 }))).toContain('0 days left');
  });

  it('says plainly that a zero allowance cannot be filed against', () => {
    expect(describeWfhQuota(quota({ weeklyAllowance: 0, remainingDays: 0, usedDays: 0 }))).toMatch(
      /no work-from-home allowance/,
    );
  });
});

describe('fitsWfhQuota', () => {
  it('does not block while the quota is unknown', () => {
    expect(fitsWfhQuota(undefined, 3)).toBe(true);
  });

  it('accepts days up to what remains and refuses more', () => {
    expect(fitsWfhQuota(quota(), 1)).toBe(true);
    expect(fitsWfhQuota(quota(), 2)).toBe(false);
  });

  it('refuses everything under a zero allowance', () => {
    expect(fitsWfhQuota(quota({ weeklyAllowance: 0, remainingDays: 0 }), 1)).toBe(false);
  });
});
