/**
 * Unit tests — who sees a PENDING WFH mark on the WIO calendar: the requester, their own manager
 * and HR only. Approved marks are visible to everyone.
 *
 * The authz double is a ROLE TABLE mirroring the catalogue (a manager holds `workforce.read` and
 * `workforce.wfh.review` but NOT `workforce.manage`; HR holds `workforce.manage`), and the roster
 * carries real manager links, so the rule is exercised, not the stub.
 */
import { describe, expect, it, vi } from 'vitest';
import { WioCalendarService } from './wio-calendar.service';

const ROLES: Record<string, string[]> = {
  hr: ['workforce.read', 'workforce.manage'],
  'mgr-a': ['workforce.read', 'workforce.wfh.review'], // alice's manager
  'mgr-b': ['workforce.read', 'workforce.wfh.review'], // another team's manager
  alice: [],
  carol: [],
};

const ROSTER = [
  { id: 'alice', name: 'alice', department: null, managerId: 'mgr-a' },
  { id: 'bob', name: 'bob', department: null, managerId: 'mgr-b' },
  { id: 'carol', name: 'carol', department: null, managerId: null },
];
// 2026-11-03 is a Tuesday; no holidays. Alice's is pending, Bob's approved.
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

async function view(viewerId?: string): Promise<string[]> {
  const answers = [ROSTER, WINDOWS, [], []];
  const db = { select: vi.fn().mockImplementation(() => chain(answers.shift() ?? [])) };
  const authz = {
    check: vi
      .fn()
      .mockImplementation((user: string, perm: string) =>
        Promise.resolve((ROLES[user] ?? []).includes(perm)),
      ),
  };
  const svc = new WioCalendarService(authz as never, db as never);
  const month = await svc.getMonth(
    '2026-11',
    viewerId ? { sub: viewerId, email: `${viewerId}@x` } : undefined,
  );
  return month.wfh.map((m) => `${m.employeeId}:${m.status}`).sort();
}

const WITH_PENDING = ['alice:pending', 'bob:approved'];
const APPROVED_ONLY = ['bob:approved'];

describe('WIO calendar pending visibility', () => {
  it('the requester sees their own pending mark', async () => {
    expect(await view('alice')).toEqual(WITH_PENDING);
  });
  it("the requester's own manager sees it", async () => {
    expect(await view('mgr-a')).toEqual(WITH_PENDING);
  });
  it('ANOTHER team’s manager does not — workforce.read alone is not enough', async () => {
    expect(await view('mgr-b')).toEqual(APPROVED_ONLY);
  });
  it('HR sees it', async () => {
    expect(await view('hr')).toEqual(WITH_PENDING);
  });
  it('a plain colleague sees only approved marks', async () => {
    expect(await view('carol')).toEqual(APPROVED_ONLY);
  });
  it('no viewer means approved only', async () => {
    expect(await view()).toEqual(APPROVED_ONLY);
  });
});
