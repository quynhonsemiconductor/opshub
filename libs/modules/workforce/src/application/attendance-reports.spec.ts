/**
 * Unit tests — the CSV sheets and the morning sweep's day arithmetic.
 *
 * The month derivation itself is e2e-tested; here it is stubbed, so what these specs pin is the
 * SHAPE of the outputs built on top of it: the summary's halves, the formula guard, the per-day
 * sheet's columns, the sweep's skip rules, and the previous-working-day walk.
 */
import { createFakeAudit } from '../../../audit/src/testing/audit.fake';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActorScope } from '@platform';
import { AttendanceService } from './attendance.service';

const mockRepo = {} as never;
const mockAudit = createFakeAudit();
const mockEngine = { submit: vi.fn(), approve: vi.fn(), reject: vi.fn(), cancel: vi.fn() };
const mockAuthz = { check: vi.fn().mockResolvedValue(true) };

const HR = { sub: 'hr-1', email: 'hr@opshub.local' };

/** A service whose month derivation answers `month`; holidays go to `previousWorkingDay` directly. */
function service(month: unknown): AttendanceService {
  const db = {
    select: vi.fn(() => {
      // The holiday probe: select().from().where().limit() resolves the canned holiday dates
      // (empty = every candidate is a working day).
      const p = Promise.resolve([]);
      const terminal: Record<string, unknown> = {
        then: p.then.bind(p),
        catch: p.catch.bind(p),
      };
      terminal.limit = vi.fn(() => terminal);
      const chain: Record<string, unknown> = {
        from: vi.fn(() => chain),
        where: vi.fn(() => terminal),
        orderBy: vi.fn(() => chain),
        limit: vi.fn(() => chain),
      };
      return chain;
    }),
    execute: vi.fn().mockResolvedValue({ rows: [] }),
  };
  const svc = new AttendanceService(
    mockRepo,
    mockAudit as never,
    mockEngine as never,
    mockAuthz as never,
    new ActorScope(mockAuthz as never),
    db as never,
  );
  // Private methods reached deliberately: the derivation and the scoping are e2e-tested; these
  // specs pin what the sheets and the sweep BUILD on top of them.
  const priv = svc as unknown as Record<string, unknown>;
  priv.computeMonth = vi.fn().mockResolvedValue(month);
  priv.scopedEmployees = vi
    .fn()
    .mockResolvedValue(
      (month as { employees: { id: string; name: string; department: string | null }[] }).employees,
    );
  return svc;
}

function dayRow(over: Record<string, unknown> = {}) {
  return {
    date: '2026-10-21',
    status: 'office',
    workedMinutes: 0,
    lateMinutes: null,
    earlyMinutes: null,
    flags: [],
    pendingJustification: false,
    leaveType: null,
    leavePortion: null,
    ...over,
  };
}

const AN = {
  id: 'me',
  name: 'An',
  department: 'IT',
  days: [
    dayRow({ status: 'office', workedMinutes: 480 }),
    dayRow({ status: 'office', workedMinutes: 240, leaveType: 'annual', leavePortion: 'morning' }),
    dayRow({ status: 'wfh', workedMinutes: 480 }),
  ],
};

describe('summaryCsv', () => {
  beforeEach(() => vi.clearAllMocks());

  it('counts a half-day 0.5 and 0.5, and the header is the contract', async () => {
    const csv = await service({ month: '2026-10', employees: [AN] }).summaryCsv('2026-10', HR);
    const [header, row] = csv.trim().split('\r\n');
    expect(header).toBe(
      'employee,department,office_days,wfh_days,leave_annual,leave_sick,leave_unpaid,' +
        'leave_parental,leave_other,unexcused_absences,late_count,early_count,total_hours',
    );
    const fields = row.split(',');
    expect(fields[2]).toBe('1.5'); // office
    expect(fields[3]).toBe('1'); // wfh
    expect(fields[4]).toBe('0.5'); // annual
    expect(fields[12]).toBe('20.00'); // hours: 480+240+480 minutes = 20h
  });

  it('neutralises values a spreadsheet would read as formulas', async () => {
    const csv = await service({
      month: '2026-10',
      employees: [{ ...AN, name: '=SUM(A1:A9)', department: '@cmd' }],
    }).summaryCsv('2026-10', HR);
    expect(csv).toContain("'=SUM(A1:A9)");
    expect(csv).toContain("'@cmd");
    expect(csv).not.toMatch(/[^']=SUM/);
  });
});

describe('daysCsv', () => {
  it('one row per employee per day, flags space-joined, pending marked', async () => {
    const csv = await service({
      month: '2026-10',
      employees: [
        {
          ...AN,
          days: [
            dayRow({ flags: ['late', 'unsynced'], pendingJustification: true, workedMinutes: 450 }),
          ],
        },
      ],
    }).daysCsv('2026-10', HR);
    const [header, row] = csv.trim().split('\r\n');
    expect(header).toBe(
      'employee,department,date,status,worked_hours,late_minutes,early_minutes,flags,justification_pending',
    );
    expect(row).toContain('"late unsynced"');
    expect(row.endsWith('yes')).toBe(true);
  });
});

describe('the morning sweep', () => {
  it('skips a day whose justification is pending, and the offboarded person entirely', async () => {
    const flagged = await service({
      month: '2026-10',
      employees: [
        { ...AN, id: 'me', name: 'An', days: [dayRow({ flags: ['late'] })] },
        {
          ...AN,
          id: 'binh',
          name: 'Binh',
          days: [dayRow({ flags: ['absent'], pendingJustification: true })],
        },
        {
          ...AN,
          id: 'old',
          name: 'Old',
          status: 'offboarded',
          days: [dayRow({ flags: ['absent'] })],
        },
      ],
    }).unresolvedFlagsFor('2026-10-21');
    expect(flagged).toEqual([{ employeeId: 'me', name: 'An', flags: ['late'] }]);
  });
});

describe('previousWorkingDay', () => {
  it('Monday looks back to Friday, not Sunday', async () => {
    // 2026-10-26 is a Monday, 07:00 HCM (=00:00Z).
    const date = await service({ month: '2026-10', employees: [] }).previousWorkingDay(
      new Date('2026-10-26T00:00:00Z'),
    );
    expect(date).toBe('2026-10-23'); // Friday
  });

  it('steps over a declared holiday to the last worked day', async () => {
    // 2026-10-22 Thursday; make Wednesday the 21st a holiday → Tuesday the 20th is the answer.
    const date = await service({ month: '2026-10', employees: [] }).previousWorkingDay(
      new Date('2026-10-22T00:00:00Z'),
      new Set(['2026-10-21']),
    );
    expect(date).toBe('2026-10-20');
  });
});
