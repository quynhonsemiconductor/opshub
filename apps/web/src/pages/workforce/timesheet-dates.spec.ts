/**
 * The expansion and chunking math behind bulk timesheet logging, pinned on its own.
 *
 * A range that silently loses a day, or a batch boundary that drops an entry, is payroll data that
 * never arrives and nobody misses — the kind of bug a rendered form never shows, because the form
 * only ever shows the fields, never what they expand to. These are the functions the endpoint's
 * promise rests on: every day in the range, exactly once, in batches the API accepts.
 */
import { describe, expect, it } from 'vitest';
import {
  BULK_MAX_ENTRIES,
  chunkDrafts,
  expandDates,
  expandToDrafts,
  isCompleteTimePair,
  minutesBetweenTimes,
  onWeekdays,
} from './timesheet-dates';

describe('minutesBetweenTimes', () => {
  it('subtracts an ordinary pair', () => {
    expect(minutesBetweenTimes('09:00', '17:30')).toBe(510);
  });

  it('treats an end before the start as an overnight shift, as the API does', () => {
    // `spanMinutes` on the backend: end < start is a shift that crossed midnight, not an error.
    expect(minutesBetweenTimes('22:00', '06:00')).toBe(480);
  });

  it('caps at a full day minus one minute — never a zero-minute "midnight to midnight"', () => {
    expect(minutesBetweenTimes('00:00', '23:59')).toBe(1439);
  });
});

describe('isCompleteTimePair', () => {
  it('accepts only a complete HH:mm pair', () => {
    expect(isCompleteTimePair('09:00', '17:30')).toBe(true);
  });

  it('refuses a half-typed pair — the API takes times as a pair or not at all', () => {
    expect(isCompleteTimePair('09:00', '')).toBe(false);
    expect(isCompleteTimePair('', '')).toBe(false);
  });
});

describe('expandDates', () => {
  it('emits every day in an inclusive window, in order', () => {
    expect(expandDates({ from: '2026-03-04', to: '2026-03-07' })).toEqual([
      '2026-03-04',
      '2026-03-05',
      '2026-03-06',
      '2026-03-07',
    ]);
  });

  it('keeps every day across a month boundary', () => {
    expect(expandDates({ from: '2026-01-30', to: '2026-02-02' })).toEqual([
      '2026-01-30',
      '2026-01-31',
      '2026-02-01',
      '2026-02-02',
    ]);
  });

  it('keeps every day across the spring-forward DST night', () => {
    // 8 March 2026 is the US spring-forward; local calendar arithmetic must not lose a date to it.
    expect(expandDates({ from: '2026-03-06', to: '2026-03-10' })).toEqual([
      '2026-03-06',
      '2026-03-07',
      '2026-03-08',
      '2026-03-09',
      '2026-03-10',
    ]);
  });

  it('answers a one-day window with one day', () => {
    expect(expandDates({ from: '2026-03-04', to: '2026-03-04' })).toEqual(['2026-03-04']);
  });
});

describe('onWeekdays', () => {
  const WEEK = expandDates({ from: '2026-03-09', to: '2026-03-15' }); // Mon 9th … Sun 15th

  it('keeps the ISO weekdays asked for (Mon = 1 … Sun = 7)', () => {
    expect(onWeekdays(WEEK, [1, 2, 3, 4, 5])).toEqual([
      '2026-03-09',
      '2026-03-10',
      '2026-03-11',
      '2026-03-12',
      '2026-03-13',
    ]);
  });

  it('can ask for the weekend alone', () => {
    expect(onWeekdays(WEEK, [6, 7])).toEqual(['2026-03-14', '2026-03-15']);
  });
});

describe('expandToDrafts', () => {
  it('stamps one draft per date with the shared duration and note', () => {
    expect(expandToDrafts(['2026-03-09', '2026-03-10'], 480, 'Project work')).toEqual([
      { workDate: '2026-03-09', minutesWorked: 480, note: 'Project work' },
      { workDate: '2026-03-10', minutesWorked: 480, note: 'Project work' },
    ]);
  });
});

describe('chunkDrafts', () => {
  it('splits at the endpoint ceiling, in order, nothing dropped or duplicated', () => {
    const drafts = expandToDrafts(
      expandDates({ from: '2026-03-10', to: '2026-07-07' }), // 120 days
      480,
    );
    const batches = chunkDrafts(drafts);
    expect(batches.map((batch) => batch.length)).toEqual([50, 50, 20]);
    expect(batches.flat()).toEqual(drafts);
    expect(batches[0][0].workDate).toBe('2026-03-10');
    expect(batches[2][19].workDate).toBe('2026-07-07');
  });

  it('sends a batch smaller than the ceiling whole, and answers an empty expansion with nothing', () => {
    expect(chunkDrafts(expandToDrafts(['2026-03-09'], 480))).toHaveLength(1);
    expect(chunkDrafts([])).toEqual([]);
  });

  it('never exceeds the limit the endpoint validates', () => {
    const drafts = expandToDrafts(expandDates({ from: '2026-01-01', to: '2026-12-31' }), 480);
    expect(chunkDrafts(drafts).every((batch) => batch.length <= BULK_MAX_ENTRIES)).toBe(true);
  });
});
