/**
 * Unit tests — the morning sweep against the REAL month derivation (only the database answers are
 * canned), and the previous-working-day walk through the holiday TABLE rather than a passed-in set.
 */
import { createFakeAudit } from '../../../audit/src/testing/audit.fake';
import { describe, expect, it, vi } from 'vitest';
import { ActorScope } from '@platform';
import { AttendanceService } from './attendance.service';

function chain(rows: unknown) {
  const c: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'orderBy', 'limit', 'innerJoin'])
    c[m] = vi.fn().mockReturnValue(c);
  c['then'] = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) =>
    Promise.resolve(rows).then(ok, bad);
  return c;
}

/** Successive select() calls resolve `answers` in order. */
function service(answers: unknown[]): AttendanceService {
  const queue = [...answers];
  const db = { select: vi.fn(() => chain(queue.shift() ?? [])) };
  const authz = { check: vi.fn().mockResolvedValue(true) };
  return new AttendanceService(
    {} as never,
    createFakeAudit() as never,
    {} as never,
    authz as never,
    new ActorScope(authz as never),
    db as never,
  );
}

const DATE = '2026-10-21'; // a Wednesday, no holiday
const person = (id: string, status = 'active') => ({
  id,
  name: id,
  department: null,
  status,
});
const swipe = (employeeId: string, time: string) => ({
  employeeId,
  date: DATE,
  time,
  timeSynced: true,
});

describe('unresolvedFlagsFor over the real derivation', () => {
  it('flags the employee with a lone swipe, skips pending, offboarded and clean days', async () => {
    const svc = service([
      // rosterForMonth: employees, then their contracts
      [person('lone'), person('pending'), person('left', 'offboarded'), person('clean')],
      [{ employeeId: 'left', startDate: '2026-01-01', endDate: null }],
      // computeMonth's five reads: holidays, leave, wfh, justifications, swipes
      [],
      [],
      [],
      [{ employeeId: 'pending', startDate: DATE, endDate: DATE, status: 'pending' }],
      [
        swipe('lone', '08:00'),
        swipe('pending', '08:00'),
        swipe('left', '08:00'),
        swipe('clean', '08:00'),
        swipe('clean', '17:30'),
      ],
      // employmentByEmployee, second pass inside computeMonth
      [{ employeeId: 'left', startDate: '2026-01-01', endDate: null }],
    ]);
    const out = await svc.unresolvedFlagsFor(DATE);
    expect(out.map((o) => o.employeeId)).toEqual(['lone']);
    expect(out[0].flags).toContain('missing_checkout');
  });

  it('returns nothing for a date that is not a working day (a holiday)', async () => {
    const svc = service([
      [person('lone')],
      [],
      [{ date: DATE }], // the calendar declares the day a holiday
      [],
      [],
      [],
      [swipe('lone', '08:00')],
      [],
    ]);
    expect(await svc.unresolvedFlagsFor(DATE)).toEqual([]);
  });
});

describe('previousWorkingDay through the holiday table', () => {
  it('steps over a day the DB declares a holiday', async () => {
    // Thursday 2026-10-22, 07:00 HCM. Wednesday the 21st is in the table; Tuesday is not.
    const svc = service([[{ date: '2026-10-21' }], []]);
    expect(await svc.previousWorkingDay(new Date('2026-10-22T00:00:00Z'))).toBe('2026-10-20');
  });

  it('skips the weekend without asking the table about it', async () => {
    // Monday 2026-10-26: Sunday and Saturday are skipped; Friday is free.
    const svc = service([[]]);
    expect(await svc.previousWorkingDay(new Date('2026-10-26T00:00:00Z'))).toBe('2026-10-23');
  });
});
