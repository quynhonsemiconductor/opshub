/**
 * Unit tests — who sees a PENDING WFH mark on the WIO calendar: the requester, their manager and
 * HR (global workforce.read) only. Approved marks are visible to everyone. The db is a fake that
 * answers selects in call order (people, wfh, leave, holidays, then the viewer's reports).
 */
import { describe, expect, it, vi } from 'vitest';
import { WioCalendarService } from './wio-calendar.service';

const PEOPLE = ['alice', 'bob', 'carol'].map((id) => ({ id, name: id, department: null }));
// 2026-11-03 is a Tuesday; no holidays.
const WINDOWS = [
  { employeeId: 'alice', startDate: '2026-11-03', endDate: '2026-11-03', status: 'pending' },
  { employeeId: 'bob', startDate: '2026-11-03', endDate: '2026-11-03', status: 'approved' },
];

function chain(result: unknown) {
  const c: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'orderBy']) c[m] = vi.fn().mockReturnValue(c);
  c['then'] = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) =>
    Promise.resolve(result).then(ok, bad);
  return c;
}

function build(opts: { hr?: boolean; reports?: string[] }) {
  const answers = [PEOPLE, WINDOWS, [], [], (opts.reports ?? []).map((id) => ({ id }))];
  const db = { select: vi.fn().mockImplementation(() => chain(answers.shift() ?? [])) };
  const authz = { check: vi.fn().mockResolvedValue(opts.hr ?? false) };
  return new WioCalendarService(authz as never, db as never);
}

const view = async (svc: WioCalendarService, viewer?: { sub: string; email: string }) =>
  (await svc.getMonth('2026-11', viewer)).wfh.map((m) => `${m.employeeId}:${m.status}`).sort();

describe('WIO calendar pending visibility', () => {
  it('the requester sees their own pending mark', async () => {
    expect(await view(build({}), { sub: 'alice', email: 'a@x' })).toEqual([
      'alice:pending',
      'bob:approved',
    ]);
  });

  it('their manager sees it', async () => {
    expect(await view(build({ reports: ['alice'] }), { sub: 'mgr', email: 'm@x' })).toEqual([
      'alice:pending',
      'bob:approved',
    ]);
  });

  it('HR (global workforce.read) sees it', async () => {
    expect(await view(build({ hr: true }), { sub: 'hr', email: 'h@x' })).toEqual([
      'alice:pending',
      'bob:approved',
    ]);
  });

  it('a colleague sees only the approved mark', async () => {
    expect(await view(build({}), { sub: 'carol', email: 'c@x' })).toEqual(['bob:approved']);
  });

  it('a manager of someone ELSE does not see it', async () => {
    expect(await view(build({ reports: ['carol'] }), { sub: 'mgr2', email: 'm@x' })).toEqual([
      'bob:approved',
    ]);
  });

  it('no viewer named means approved only', async () => {
    expect(await view(build({}))).toEqual(['bob:approved']);
  });
});
