/**
 * format — the three ways the inlined `toLocaleDateString()` was wrong.
 *
 * A `.ts` spec: these are pure functions over strings, so no DOM.
 */
import { describe, expect, it } from 'vitest';
import {
  EM_DASH,
  formatDate,
  formatDateTime,
  formatDecimal,
  formatDuration,
  formatMoney,
  formatTime,
  formatTimeUntil,
  orDash,
} from './format';

describe('formatDate', () => {
  it('formats a calendar date unambiguously', () => {
    // `4 Mar 2026`, not `03/04/2026` — which means March in one browser and April in another.
    expect(formatDate('2026-03-04')).toBe('4 Mar 2026');
  });

  it('does NOT shift a calendar date across a timezone', () => {
    // The bug this function exists for. `new Date('2026-03-04')` is UTC midnight, so anywhere behind
    // UTC it renders as the 3rd — and a leave request that starts on the 4th must not read as the
    // 3rd because the reader is in Vancouver. Formatted from the parts instead.
    expect(formatDate('2026-01-01')).toBe('1 Jan 2026');
    expect(formatDate('2026-12-31')).toBe('31 Dec 2026');
  });

  it('renders the em dash for absent values rather than "Invalid Date"', () => {
    // Several call sites passed a nullable API field straight in, which put the literal string
    // "Invalid Date" in the middle of a table.
    expect(formatDate(null)).toBe(EM_DASH);
    expect(formatDate(undefined)).toBe(EM_DASH);
    expect(formatDate('')).toBe(EM_DASH);
    expect(formatDate('not a date')).toBe(EM_DASH);
  });

  it('takes a full timestamp or a Date as well', () => {
    expect(formatDate('2026-03-04T22:30:00.000Z')).toMatch(/Mar 2026$/);
    expect(formatDate(new Date(Date.UTC(2026, 2, 4)))).toMatch(/Mar 2026$/);
  });
});

describe('formatDateTime', () => {
  it('includes the time', () => {
    expect(formatDateTime('2026-03-04T14:32:00.000Z')).toMatch(/4 Mar 2026, \d{2}:\d{2}/);
  });

  it('em-dashes an absent or unparseable value', () => {
    expect(formatDateTime(null)).toBe(EM_DASH);
    expect(formatDateTime(undefined)).toBe(EM_DASH);
    expect(formatDateTime('')).toBe(EM_DASH);
    expect(formatDateTime('nonsense')).toBe(EM_DASH);
  });

  it('takes a Date as well as a string', () => {
    // The `instanceof` branch: an API field arrives as a string, but a `new Date()` in a page does not.
    expect(formatDateTime(new Date(Date.UTC(2026, 2, 4, 14, 32)))).toMatch(
      /4 Mar 2026, \d{2}:\d{2}/,
    );
  });
});

describe('formatTime', () => {
  it('formats a clock time in 24-hour, not the browser’s preference', () => {
    /*
     * THE DRIFT, as a test. The attendance widget used `toLocaleTimeString([], ...)`, and `[]` means
     * the BROWSER's locale — so "Clocked in at" read `02:32 PM` on one machine and `14:32` on another,
     * while `formatDateTime` a few pixels away always said `14:32`.
     */
    expect(formatTime('2026-03-04T14:32:00.000Z')).toMatch(/^\d{2}:\d{2}$/);
    expect(formatTime('2026-03-04T14:32:00.000Z')).not.toMatch(/[AP]M/i);
  });

  it('agrees with formatDateTime about the same instant', () => {
    // Two clocks in one view must not disagree about how to write one minute. This is the property the
    // hand-rolled call broke, and it is checked against the OTHER formatter rather than a literal, so
    // it holds wherever the suite runs.
    const iso = '2026-03-04T14:32:00.000Z';
    expect(formatDateTime(iso)).toContain(formatTime(iso));
  });

  it('em-dashes an absent or unparseable value', () => {
    // The old call site wrote `current ? ... : '—'` by hand; the guard lives in the formatter now, so
    // `formatTime(current?.clockedInAt)` is the whole expression.
    expect(formatTime(null)).toBe(EM_DASH);
    expect(formatTime(undefined)).toBe(EM_DASH);
    expect(formatTime('')).toBe(EM_DASH);
    expect(formatTime('nonsense')).toBe(EM_DASH);
  });
});

describe('formatDecimal', () => {
  it('drops trailing zeros from a numeric column, so a column of days lines up', () => {
    // `numeric` arrives as a STRING: '2.50' and '2.00' must read as 2.5 and 2, not as one of each
    // style depending on which page formatted it.
    expect(formatDecimal('2.50')).toBe('2.5');
    expect(formatDecimal('2.00')).toBe('2');
    expect(formatDecimal(0.5)).toBe('0.5');
  });

  it('keeps a legitimate zero', () => {
    expect(formatDecimal('0.00')).toBe('0');
    expect(formatDecimal(0)).toBe('0');
  });

  it('em-dashes absent and unparseable values', () => {
    expect(formatDecimal(null)).toBe(EM_DASH);
    expect(formatDecimal('')).toBe(EM_DASH);
    expect(formatDecimal('abc')).toBe(EM_DASH);
  });
});

describe('orDash', () => {
  it('passes a present value through untouched, INCLUDING zero and false', () => {
    expect(orDash('x')).toBe('x');
    expect(orDash(0)).toBe(0);
    expect(orDash(false)).toBe(false);
  });

  it('replaces only null, undefined and the empty string', () => {
    expect(orDash(null)).toBe(EM_DASH);
    expect(orDash(undefined)).toBe(EM_DASH);
    expect(orDash('')).toBe(EM_DASH);
  });
});

describe('formatMoney', () => {
  it('formats integer cents as currency, naming the currency', () => {
    // Cents in the column, a string at the edge, no float in between — which is why the column is an
    // integer in the first place.
    //
    // `US$` and not a bare `$`: the shared locale is `en-GB` for the same reason dates are, and a
    // product used across countries should not leave "$12.50" to mean whichever dollar the reader
    // assumes. The finops screen's own formatter printed the bare symbol.
    expect(formatMoney(1250)).toBe('US$12.50');
    expect(formatMoney(0)).toBe('US$0.00');
    expect(formatMoney(123456789)).toBe('US$1,234,567.89');
  });

  it('takes a currency', () => {
    expect(formatMoney(1250, 'EUR')).toContain('12.50');
  });

  it('em-dashes an absent amount, and keeps a real zero', () => {
    expect(formatMoney(null)).toBe(EM_DASH);
    expect(formatMoney(undefined)).toBe(EM_DASH);
    expect(formatMoney(Number.NaN)).toBe(EM_DASH);
    expect(formatMoney(0)).not.toBe(EM_DASH);
  });
});

describe('formatTimeUntil', () => {
  /*
   * A FIXED `now`, PASSED IN. The first version of this suite built its inputs from `Date.now()` and let the
   * function read the clock again a millisecond later — so `47 * 60_000` floored to "46m left" whenever the
   * two reads straddled a minute, and the suite failed roughly one run in three. `now` is a parameter for
   * exactly this reason; a test of a pure function should not be racing the clock.
   */
  const NOW = Date.parse('2026-08-18T12:00:00.000Z');
  const inMs = (ms: number) => new Date(NOW + ms).toISOString();
  const until = (ms: number) => formatTimeUntil(inMs(ms), NOW);

  it('reads as a remaining budget, one coarse unit at a time', () => {
    // The question a time-boxed grant raises is "how long do I still hold this", never "at what o'clock
    // does it lapse" — so one unit, rounded down, is the honest precision.
    expect(until(47 * 60_000)).toBe('47m left');
    expect(until(3 * 3_600_000)).toBe('3h left');
    expect(until(2 * 86_400_000 + 3_600_000)).toBe('2d left');
  });

  it('rounds DOWN, so it never promises time that has gone', () => {
    // 119 minutes is "1h left", not "2h left". Rounding up on a privileged-access window would tell
    // somebody they had longer than they do.
    expect(until(119 * 60_000)).toBe('1h left');
    expect(until(59_000)).toBe('0m left');
  });

  it('says Expired rather than a negative', () => {
    // A grant whose window closed is gone, not "-12h left".
    expect(until(-60_000)).toBe('Expired');
    expect(formatTimeUntil(new Date(NOW - 1), NOW)).toBe('Expired');
    // Exactly now is expired too: the boundary belongs to the past, so a window is never "0m left" at the
    // instant it closes.
    expect(until(0)).toBe('Expired');
  });

  it('em-dashes what it cannot read', () => {
    expect(formatTimeUntil(null, NOW)).toBe(EM_DASH);
    expect(formatTimeUntil(undefined, NOW)).toBe(EM_DASH);
    expect(formatTimeUntil('not a date', NOW)).toBe(EM_DASH);
  });

  it('defaults `now` to the real clock, so callers that do not care need not pass one', () => {
    /*
     * OFF THE BOUNDARY, deliberately. An exact multiple of a day races the clock: if both `Date.now()` reads
     * land in the same millisecond it is "5d left", and if they straddle one it is "4d". Half a day past the
     * boundary answers the same either way — which is the whole reason the other cases here pass `now`.
     */
    expect(formatTimeUntil(new Date(Date.now() + 5.5 * 86_400_000))).toBe('5d left');
  });
});

describe('formatDuration', () => {
  it('says a length the way it is said aloud, dropping the empty unit', () => {
    expect(formatDuration(510)).toBe('8h 30m');
    expect(formatDuration(480)).toBe('8h');
    expect(formatDuration(45)).toBe('45m');
    // A zero length is a real answer — `0m`, not the em dash that means "absent".
    expect(formatDuration(0)).toBe('0m');
  });

  it('floors a fractional hour instead of rounding a duration up', () => {
    // 90.5 minutes is 1h 30m of held time; rounding to 1h 31m would promise time nobody holds.
    expect(formatDuration(90.5)).toBe('1h 30m');
  });

  it('treats a negative as nothing held, not as time running backwards', () => {
    expect(formatDuration(-30)).toBe('0m');
  });
});
