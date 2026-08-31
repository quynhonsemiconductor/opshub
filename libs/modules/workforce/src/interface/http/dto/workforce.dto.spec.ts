/**
 * Workforce DTO schemas — timesheet start/end derivation, the date-range list filters and the
 * bulk envelope.
 *
 * Pure schema tests: no database, no HTTP. They guard the contract any client codes against,
 * most importantly the DERIVED `minutesWorked` — a value the caller may still send alongside
 * start/end times is deliberately ignored, and these tests are where that decision is visible as
 * behaviour rather than as a comment on the transform.
 */
import { describe, expect, it } from 'vitest';
import {
  BulkCreateTimesheetsSchema,
  CreateTimesheetSchema,
  ListLeaveQuerySchema,
  ListOvertimeQuerySchema,
  ListTimesheetsQuerySchema,
} from './workforce.dto';

/** A valid single-create body, so each test names only the field it is about. */
function entry(overrides: Record<string, unknown> = {}) {
  return { workDate: '2026-08-31', minutesWorked: 480, ...overrides };
}

describe('CreateTimesheetSchema — start/end derivation', () => {
  it('derives minutesWorked from a same-day span, overwriting the value that was sent', () => {
    // The disagreeing 600 is the point: with both times present, the span wins.
    const parsed = CreateTimesheetSchema.parse(
      entry({ startTime: '09:00', endTime: '17:00', minutesWorked: 600 }),
    );
    expect(parsed.minutesWorked).toBe(480);
  });

  it('treats an end before the start as an overnight shift, not an error', () => {
    // 22:00 → 06:00 is 8 hours worked; workDate names the day the shift started.
    const parsed = CreateTimesheetSchema.parse(entry({ startTime: '22:00', endTime: '06:00' }));
    expect(parsed.minutesWorked).toBe(480);
  });

  it('derives a span that lands exactly on midnight as the full minutes worked', () => {
    // 08:00 → 00:00 (same day) is 16 hours; the modulo must not wrap this one.
    const parsed = CreateTimesheetSchema.parse(entry({ startTime: '08:00', endTime: '00:00' }));
    expect(parsed.minutesWorked).toBe(960);
  });

  it('caps a derived span below the 1440-minute ceiling, so derivation never invents an invalid value', () => {
    // The widest span the clock face allows is 23:59 — equal times being refused upstream.
    const parsed = CreateTimesheetSchema.parse(entry({ startTime: '00:00', endTime: '23:59' }));
    expect(parsed.minutesWorked).toBe(1439);
  });

  it('keeps minutesWorked as-is when it is given without times', () => {
    const parsed = CreateTimesheetSchema.parse(entry({ minutesWorked: 300 }));
    expect(parsed.minutesWorked).toBe(300);
  });

  it('drops the times from the parsed value, so nothing downstream learns a new field', () => {
    // The service, repository and audit metadata all read minutesWorked only; if the times
    // leaked through, they would silently become part of every payload those layers see.
    const parsed = CreateTimesheetSchema.parse(entry({ startTime: '09:00', endTime: '17:00' }));
    expect(parsed).not.toHaveProperty('startTime');
    expect(parsed).not.toHaveProperty('endTime');
  });

  it('refuses one time without the other', () => {
    expect(CreateTimesheetSchema.safeParse(entry({ startTime: '09:00' })).success).toBe(false);
    expect(CreateTimesheetSchema.safeParse(entry({ endTime: '17:00' })).success).toBe(false);
  });

  it('refuses equal times — a zero-minute shift is a typo, not a midnight-to-midnight one', () => {
    // This is the ONE case the overnight rule does not cover: end === start.
    const parsed = CreateTimesheetSchema.safeParse(entry({ startTime: '09:00', endTime: '09:00' }));
    expect(parsed.success).toBe(false);
  });

  it('refuses a time that is not a zero-padded clock time', () => {
    // `9:00` and `25:00` — the vocabulary check, not the span arithmetic.
    expect(
      CreateTimesheetSchema.safeParse(entry({ startTime: '9:00', endTime: '17:00' })).success,
    ).toBe(false);
    expect(
      CreateTimesheetSchema.safeParse(entry({ startTime: '25:00', endTime: '02:00' })).success,
    ).toBe(false);
  });
});

describe('ListTimesheetsQuerySchema — date range', () => {
  it('accepts dateFrom and dateTo alone, without pagination', () => {
    const parsed = ListTimesheetsQuerySchema.parse({
      dateFrom: '2026-08-01',
      dateTo: '2026-08-31',
    });
    expect(parsed.dateFrom).toBe('2026-08-01');
    expect(parsed.dateTo).toBe('2026-08-31');
  });

  it('rejects an inverted range', () => {
    const parsed = ListTimesheetsQuerySchema.safeParse({
      dateFrom: '2026-08-31',
      dateTo: '2026-08-01',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts either bound alone — an open-ended range is a real query', () => {
    expect(ListTimesheetsQuerySchema.safeParse({ dateFrom: '2026-08-01' }).success).toBe(true);
    expect(ListTimesheetsQuerySchema.safeParse({ dateTo: '2026-08-31' }).success).toBe(true);
  });

  it('still defaults the pagination fields the SPA has always relied on', () => {
    const parsed = ListTimesheetsQuerySchema.parse({});
    expect(parsed.limit).toBeDefined();
    expect(parsed.offset).toBeDefined();
  });
});

describe('ListLeaveQuerySchema / ListOvertimeQuerySchema — date range', () => {
  // Same contract as the timesheet list, so the SPA's date-range picker speaks one dialect across
  // all three lists; leave bounds land on `startDate` (window BEGINS in range), overtime's on
  // `workDate` — the repository owns that difference, not the query vocabulary.
  describe.each([
    ['ListLeaveQuerySchema', ListLeaveQuerySchema],
    ['ListOvertimeQuerySchema', ListOvertimeQuerySchema],
  ] as const)('%s', (_name, schema) => {
    it('accepts dateFrom and dateTo alone, without pagination', () => {
      const parsed = schema.parse({ dateFrom: '2026-08-01', dateTo: '2026-08-31' });
      expect(parsed.dateFrom).toBe('2026-08-01');
      expect(parsed.dateTo).toBe('2026-08-31');
    });

    it('rejects an inverted range', () => {
      const parsed = schema.safeParse({ dateFrom: '2026-08-31', dateTo: '2026-08-01' });
      expect(parsed.success).toBe(false);
    });

    it('accepts either bound alone — an open-ended range is a real query', () => {
      expect(schema.safeParse({ dateFrom: '2026-08-01' }).success).toBe(true);
      expect(schema.safeParse({ dateTo: '2026-08-31' }).success).toBe(true);
    });

    it('refuses a value that is not an ISO date', () => {
      expect(schema.safeParse({ dateFrom: '31/08/2026' }).success).toBe(false);
      expect(schema.safeParse({ dateTo: '2026-02-31' }).success).toBe(false);
    });

    it('still defaults the pagination fields the SPA has always relied on', () => {
      const parsed = schema.parse({});
      expect(parsed.limit).toBeDefined();
      expect(parsed.offset).toBeDefined();
    });
  });
});

describe('BulkCreateTimesheetsSchema', () => {
  it('accepts 50 entries and derives each one like a single create', () => {
    const entries = Array.from({ length: 50 }, () =>
      entry({ startTime: '22:00', endTime: '06:00' }),
    );
    const parsed = BulkCreateTimesheetsSchema.parse({ entries });
    expect(parsed.entries).toHaveLength(50);
    expect(parsed.entries[0].minutesWorked).toBe(480);
  });

  it('rejects an empty batch and a batch over 50', () => {
    expect(BulkCreateTimesheetsSchema.safeParse({ entries: [] }).success).toBe(false);
    expect(
      BulkCreateTimesheetsSchema.safeParse({ entries: Array.from({ length: 51 }, () => entry()) })
        .success,
    ).toBe(false);
  });

  it('fails the WHOLE parse for one bad entry — nothing is half-valid', () => {
    // The validation half of all-or-nothing: entry 2 is one bad row among 50, and the parse
    // refuses the batch rather than returning a trimmed one.
    const entries = [
      entry(),
      entry({ startTime: '09:00', endTime: '09:00' }),
      ...Array.from({ length: 48 }, () => entry()),
    ];
    expect(BulkCreateTimesheetsSchema.safeParse({ entries }).success).toBe(false);
  });
});
