import { describe, expect, it } from 'vitest';
import { permissionCacheTtlSeconds } from './permission-cache-ttl.helper';

const _NOW = new Date('2026-11-03T10:00:00Z');
const _DEFAULT_TTL_SECONDS = 300;

/** An instant `seconds` after `_NOW`. */
function inSeconds(seconds: number): Date {
  return new Date(_NOW.getTime() + seconds * 1000);
}

describe('permissionCacheTtlSeconds', () => {
  it('uses the normal lifetime when nothing in the set expires', () => {
    expect(permissionCacheTtlSeconds(_DEFAULT_TTL_SECONDS, [null, null], _NOW)).toBe(300);
    expect(permissionCacheTtlSeconds(_DEFAULT_TTL_SECONDS, [], _NOW)).toBe(300);
  });

  it('stops caching at the earliest expiry when it falls inside the normal lifetime', () => {
    expect(
      permissionCacheTtlSeconds(_DEFAULT_TTL_SECONDS, [null, inSeconds(90), inSeconds(200)], _NOW),
    ).toBe(90);
  });

  it('keeps the normal lifetime when every expiry is further away', () => {
    expect(permissionCacheTtlSeconds(_DEFAULT_TTL_SECONDS, [inSeconds(3600)], _NOW)).toBe(300);
  });

  it('rounds a part-second up, so the entry never outlives the grant by a whole second', () => {
    expect(permissionCacheTtlSeconds(_DEFAULT_TTL_SECONDS, [inSeconds(10.2)], _NOW)).toBe(11);
  });

  it('never returns less than one second, even for a grant that has just lapsed', () => {
    expect(permissionCacheTtlSeconds(_DEFAULT_TTL_SECONDS, [inSeconds(0)], _NOW)).toBe(1);
    expect(permissionCacheTtlSeconds(_DEFAULT_TTL_SECONDS, [inSeconds(-5)], _NOW)).toBe(1);
  });
});
