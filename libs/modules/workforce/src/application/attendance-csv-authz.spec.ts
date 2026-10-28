/**
 * Unit tests — who a CSV export covers. The real `scopedEmployees` runs (only the month
 * derivation and the database answers are canned), so these pin the authorization itself: a
 * reader exports everybody, a manager their team and themself, an employee only themself, and
 * nobody gets a row outside their scope.
 */
import { createFakeAudit } from '../../../audit/src/testing/audit.fake';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActorScope } from '@platform';
import { AttendanceService } from './attendance.service';

const mockAuthz = { check: vi.fn() };

const EVERYONE = ['me', 'report', 'outsider', 'gone'].map((id) => ({
  id,
  name: id,
  department: null as string | null,
  status: id === 'gone' ? 'offboarded' : 'active',
  days: [
    {
      date: '2026-10-21',
      status: 'office',
      workedMinutes: 480,
      lateMinutes: null,
      earlyMinutes: null,
      flags: [],
      pendingJustification: false,
      leaveType: null,
      leavePortion: null,
    },
  ],
}));

function chain(rows: unknown) {
  const c: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'orderBy', 'limit']) c[m] = vi.fn().mockReturnValue(c);
  c['then'] = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) =>
    Promise.resolve(rows).then(ok, bad);
  return c;
}

/**
 * `answers` are the rows each successive select() resolves, in call order. The month derivation
 * is canned; `scopedEmployees` is NOT stubbed.
 */
function service(answers: unknown[]): AttendanceService {
  const queue = [...answers];
  const db = { select: vi.fn(() => chain(queue.shift() ?? [])) };
  const svc = new AttendanceService(
    {} as never,
    createFakeAudit() as never,
    {} as never,
    mockAuthz as never,
    new ActorScope(mockAuthz as never),
    db as never,
  );
  (svc as unknown as Record<string, unknown>).computeMonth = vi
    .fn()
    .mockResolvedValue({ month: '2026-10', employees: EVERYONE });
  return svc;
}

const person = (id: string) => ({ id, name: id, department: null });
const holds = (...p: string[]) =>
  mockAuthz.check.mockImplementation((_u: string, perm: string) =>
    Promise.resolve(p.includes(perm)),
  );
/** The names a CSV carries, first column, header skipped. */
const names = (csv: string) =>
  csv
    .trim()
    .split('\r\n')
    .slice(1)
    .map((l) => l.split(',')[0]);

describe.each([
  [
    'summaryCsv',
    (s: AttendanceService, a: { sub: string; email: string }) => s.summaryCsv('2026-10', a),
  ],
  ['daysCsv', (s: AttendanceService, a: { sub: string; email: string }) => s.daysCsv('2026-10', a)],
])('%s scope', (_name, run) => {
  beforeEach(() => vi.clearAllMocks());

  it('a workforce.attendance.read holder exports everybody the roster accounts for', async () => {
    holds('workforce.attendance.read');
    // rosterForMonth: employees, then their contracts (the offboarded one worked the month).
    const csv = await run(
      service([
        EVERYONE.map((e) => ({ ...e, days: undefined })),
        [{ employeeId: 'gone', startDate: '2026-01-01', endDate: '2026-12-31' }],
      ]),
      { sub: 'hr', email: 'hr@x' },
    );
    expect(names(csv).sort()).toEqual(['gone', 'me', 'outsider', 'report']);
  });

  it('a manager exports their team and themself, and nobody else', async () => {
    holds();
    // scopedEmployees: direct reports, then the caller.
    const csv = await run(service([[person('report')], [person('me')]]), {
      sub: 'me',
      email: 'me@x',
    });
    expect(names(csv).sort()).toEqual(['me', 'report']);
  });

  it('an employee with no team exports only themself', async () => {
    holds();
    const csv = await run(service([[], [person('me')]]), { sub: 'me', email: 'me@x' });
    expect(names(csv)).toEqual(['me']);
  });

  it('a caller with no employee row and no team gets the header and nothing else', async () => {
    holds();
    const csv = await run(service([[], []]), { sub: 'ghost', email: 'g@x' });
    expect(names(csv)).toEqual([]);
  });
});
