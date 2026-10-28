/**
 * Unit tests — AttendanceService access narrowing and the month-close lock.
 *
 * The attendance routes authorize in the service (an optional `employeeId` filter cannot be
 * expressed by a scope descriptor — same reason as `narrowToActor`), so these tests are what the
 * `AuthorizedInService` pins name: both directions of the list narrowing, and the lock a closed
 * month puts on requests and decisions.
 */
import { createFakeAudit } from '../../../audit/src/testing/audit.fake';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActorScope, PermissionDeniedException, PreconditionFailedException } from '@platform';
import { AttendanceService, employmentWindows, monthsOfRange } from './attendance.service';

/** A drizzle-ish chain whose every terminal resolves — the queries' shape, not their SQL. */
function selectReturning(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  const end = Promise.resolve(rows);
  for (const step of ['from', 'where', 'orderBy', 'limit', 'innerJoin'])
    chain[step] = vi.fn().mockReturnValue(chain);
  // Awaiting the builder itself (drizzle executes) or reaching `.limit` both answer with rows.
  chain.then = end.then.bind(end);
  chain.catch = end.catch.bind(end);
  chain.limit = vi.fn().mockReturnValue(end);
  return vi.fn().mockReturnValue(chain);
}

const mockRepo = {} as never;
const mockAudit = createFakeAudit();
const mockEngine = { submit: vi.fn(), approve: vi.fn(), reject: vi.fn() };
const mockAuthz = { check: vi.fn() };

const SELF = { sub: 'emp-1', email: 'emp1@test.com' };

function service(db: { select: ReturnType<typeof selectReturning> }): AttendanceService {
  return new AttendanceService(
    mockRepo,
    mockAudit as never,
    mockEngine as never,
    mockAuthz as never,
    new ActorScope(mockAuthz as never),
    db as never,
  );
}

function holds(...permissions: string[]) {
  mockAuthz.check.mockImplementation((_userId: string, permission: string) =>
    Promise.resolve(permissions.includes(permission)),
  );
}

describe('monthsOfRange', () => {
  it('is the one month of a window inside it', () => {
    expect(monthsOfRange('2026-10-05', '2026-10-20')).toEqual(['2026-10']);
  });
  it('spans the months a window crosses, endpoints included', () => {
    expect(monthsOfRange('2026-09-28', '2026-11-04')).toEqual(['2026-09', '2026-10', '2026-11']);
  });
  it('covers a year-crossing window', () => {
    expect(monthsOfRange('2026-12-20', '2027-01-05')).toEqual(['2026-12', '2027-01']);
  });
});

describe('the month-close lock', () => {
  it('refuses a request whose month is closed, naming the month', async () => {
    const db = { select: selectReturning([{ month: '2026-10' }]) };
    await expect(
      service(db).assertMonthsOpen('2026-10-05', '2026-10-20', 'A WFH request'),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(PreconditionFailedException);
      expect((err as Error).message).toContain('2026-10');
      return true;
    });
  });

  it('lets the same window through once the month is not closed', async () => {
    const db = { select: selectReturning([]) };
    await expect(
      service(db).assertMonthsOpen('2026-10-05', '2026-10-20', 'A WFH request'),
    ).resolves.toBeUndefined();
  });
});

describe('justification list narrowing', () => {
  const rows = [
    {
      id: 'j1',
      employeeId: SELF.sub,
      startDate: '2026-10-01',
      endDate: '2026-10-01',
      kind: 'late' as const,
      reason: null,
      workingDays: '1',
      status: 'pending' as const,
      reviewerId: null,
      reviewedAt: null,
      createdAt: new Date(),
      requestId: 'r1',
    },
  ];

  it('passes the filter through for a workforce.attendance.read holder', async () => {
    holds('workforce.attendance.read');
    const db = { select: selectReturning(rows) };
    await expect(
      service(db).listJustifications({ employeeId: 'emp-2', status: 'pending' }, SELF),
    ).resolves.toBe(rows);
  });

  it('denies asking for someone else without the permission — a 403, not an empty page', async () => {
    holds();
    const db = { select: selectReturning(rows) };
    await expect(
      service(db).listJustifications({ employeeId: 'emp-2' }, SELF),
    ).rejects.toBeInstanceOf(PermissionDeniedException);
  });

  it('pins a filter-less list to the caller', async () => {
    holds();
    const db = { select: selectReturning(rows) };
    await expect(service(db).listJustifications({}, SELF)).resolves.toBe(rows);
    // The query ran at all; the pinning itself is ActorScope's, and its own suite pins it.
    expect(db.select).toHaveBeenCalled();
  });
});

describe('scope decisions read the right permission', () => {
  beforeEach(() => vi.clearAllMocks());

  it('an attendance reader and a plain employee differ only by the permission checked', async () => {
    const calls: string[] = [];
    mockAuthz.check.mockImplementation((_sub: string, permission: string) => {
      calls.push(permission);
      return Promise.resolve(permission === 'workforce.attendance.read');
    });
    const everyone = { select: selectReturning([]) };
    const nobody = { select: selectReturning([]) };
    await service(everyone).getMonth('2026-10', SELF);
    await service(nobody).getMonth('2026-10', SELF);
    // Both asked the same question; the answer came from the permission, not the caller's shape.
    expect(calls.filter((c) => c === 'workforce.attendance.read')).toHaveLength(2);
  });
});

describe('employmentWindows', () => {
  it('a fixed-term contract renewed as INDEFINITE is open-ended, whichever row comes first', () => {
    const fixed = { employeeId: 'e', startDate: '2024-01-01', endDate: '2025-01-01' };
    const indefinite = { employeeId: 'e', startDate: '2025-01-02', endDate: null };
    expect(employmentWindows([fixed, indefinite]).get('e')).toEqual({
      start: '2024-01-01',
      end: null,
    });
    expect(employmentWindows([indefinite, fixed]).get('e')).toEqual({
      start: '2024-01-01',
      end: null,
    });
  });

  it('takes the latest dated end and the earliest start across dated contracts', () => {
    const rows = [
      { employeeId: 'e', startDate: '2025-01-01', endDate: '2025-12-31' },
      { employeeId: 'e', startDate: '2024-01-01', endDate: '2024-12-31' },
    ];
    expect(employmentWindows(rows).get('e')).toEqual({ start: '2024-01-01', end: '2025-12-31' });
  });
});

describe('the month roster keeps people who left, for the months they worked', () => {
  type Roster = { rosterForMonth(month: string): Promise<{ id: string }[]> };

  /** Two selects, in order: the employees, then their contracts. */
  function rosterService(people: unknown[], contracts: unknown[]) {
    const answers = [people, contracts];
    const db = {
      select: vi.fn().mockImplementation((): unknown => selectReturning(answers.shift() ?? [])()),
    };
    return service(db) as unknown as Roster;
  }

  const leaver = { id: 'gone', name: 'Gone', department: null, status: 'offboarded' as const };
  const stayer = { id: 'here', name: 'Here', department: null, status: 'active' as const };

  it('an offboarded employee still appears for a month inside their employment', async () => {
    const svc = rosterService(
      [leaver, stayer],
      [{ employeeId: 'gone', startDate: '2026-01-05', endDate: '2026-11-20' }],
    );
    expect((await svc.rosterForMonth('2026-10')).map((r) => r.id)).toEqual(['gone', 'here']);
  });

  it('and drops out for months after they left, or when they have no contract at all', async () => {
    const svc = rosterService(
      [leaver, stayer],
      [{ employeeId: 'gone', startDate: '2026-01-05', endDate: '2026-11-20' }],
    );
    expect((await svc.rosterForMonth('2026-12')).map((r) => r.id)).toEqual(['here']);
    const none = rosterService([leaver, stayer], []);
    expect((await none.rosterForMonth('2026-10')).map((r) => r.id)).toEqual(['here']);
  });
});
