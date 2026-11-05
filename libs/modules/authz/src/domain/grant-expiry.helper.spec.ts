import { describe, expect, it } from 'vitest';
import { isGrantExpired } from './grant-expiry.helper';

describe('isGrantExpired', () => {
  const now = new Date('2026-11-04T10:00:00Z');

  it('never expires a grant that has no expiry', () => {
    expect(isGrantExpired(null, now)).toBe(false);
  });

  it('keeps a grant that ends in the future', () => {
    expect(isGrantExpired(new Date('2026-11-04T10:00:01Z'), now)).toBe(false);
  });

  it('expires a grant that ended in the past', () => {
    expect(isGrantExpired(new Date('2026-11-04T09:59:59Z'), now)).toBe(true);
  });

  it('expires a grant at the very instant it ends', () => {
    expect(isGrantExpired(new Date(now), now)).toBe(true);
  });
});
