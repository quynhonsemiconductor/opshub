// @vitest-environment jsdom
/**
 * WHO MAY SUBMIT A TIMESHEET AND WHO MAY DECIDE ONE — two different rules that looked like one.
 *
 * The tab keyed both off the row's status alone, so an employee holding nothing saw Approve and Reject on
 * every submitted sheet and every click was a permanent 403. No browser test could see it: all eight
 * Playwright seats are seeded admins. See `leave-tab.spec.tsx` for the full account of the blind spot.
 *
 * THE TWO RULES, from `WorkforceService`:
 *   - `submitTimesheet` calls `assertOwnerOrApprover`: the OWNER passes on identity alone, and anybody else
 *     needs `workforce.approve`. So Submit must NOT be gated on a permission — an employee pushing their
 *     own draft through is the ordinary case, and gating it would break self-service for the whole
 *     organisation.
 *   - `reviewTimesheet` is `@RequirePermission('workforce.approve')` and nothing more. It does NOT go
 *     through the request engine, so there is no second permission — and, notably, no separation-of-duties
 *     check either. The UI withholds the decision on the viewer's own sheet anyway; the reasoning is in
 *     `timesheetReviewVerdict`, and the missing server-side check is a real gap that hiding a button does
 *     not close.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const GET = vi.fn();
const POST = vi.fn();

vi.mock('@/shared/api/client', () => ({
  api: { GET: (...a: unknown[]) => GET(...a), POST: (...a: unknown[]) => POST(...a) },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/** Mutated per test: the id decides ownership, the list decides permission. */
const viewer = { sub: 'emp-me' as string | undefined, permissions: [] as string[] };

vi.mock('@/shared/hooks/use-current-user', () => ({
  useCurrentUser: () => ({ data: viewer.sub ? { sub: viewer.sub } : undefined }),
}));
vi.mock('@/shared/hooks/use-permissions', () => ({
  usePermissions: () => ({
    can: (permission: string) =>
      viewer.permissions.includes('*') || viewer.permissions.includes(permission),
  }),
}));
vi.mock('@/shared/ui/activity-timeline', () => ({ ActivityTimeline: () => null }));

import { TimesheetsTab } from './timesheets-tab';

const BASE = {
  id: 'ts-1',
  employeeId: 'emp-colleague',
  workDate: '2026-03-02',
  minutesWorked: 480,
  note: 'Colleague sheet',
  status: 'submitted',
  submittedAt: '2026-03-02T18:00:00.000Z',
  approvedBy: null,
  createdAt: '2026-03-02T09:00:00.000Z',
};

/** Awaiting a decision, belonging to somebody else. */
const SUBMITTED = BASE;
/** Awaiting a decision, belonging to the viewer. */
const MINE_SUBMITTED = { ...BASE, id: 'ts-2', employeeId: 'emp-me', note: 'My submitted sheet' };
/** The viewer's own draft — the row Submit exists for. */
const MINE_DRAFT = {
  ...BASE,
  id: 'ts-3',
  employeeId: 'emp-me',
  status: 'draft',
  submittedAt: null,
  note: 'My draft sheet',
};
/** Somebody else's draft: submitting it on their behalf needs `workforce.approve`. */
const THEIR_DRAFT = { ...MINE_DRAFT, id: 'ts-4', employeeId: 'emp-colleague', note: 'Their draft' };

function renderTab(rows: unknown[]) {
  GET.mockResolvedValue({
    data: {
      data: rows,
      pageInfo: { total: rows.length, limit: 20, offset: 0, hasNextPage: false },
    },
    error: undefined,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TimesheetsTab />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  viewer.sub = 'emp-me';
  viewer.permissions = [];
});

describe('the Timesheets tab, for an employee who holds no permissions', () => {
  it('submits their own draft, because that is what the tab is for', async () => {
    /*
     * THE ASSERTION THAT KEEPS THE FIX HONEST. `assertOwnerOrApprover` returns immediately when the owner
     * is the actor, so no permission is involved at all. Gating Submit on `workforce.approve` — the
     * obvious mistake, since the review next door needs it — would take logging hours away from everybody
     * who is not a manager, which is a worse defect than the ungated Approve button.
     */
    renderTab([MINE_DRAFT]);
    await screen.findByText('My draft sheet');

    expect(screen.getByRole('button', { name: 'Submit' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /log timesheet/i })).toBeTruthy();
  });

  it('offers no decision on their own submitted sheet, and says who makes it', async () => {
    renderTab([MINE_SUBMITTED]);
    await screen.findByText('My submitted sheet');

    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
    expect(screen.getByText('Yours — a colleague decides')).toBeTruthy();
  });

  it('does not offer to submit somebody else’s draft', async () => {
    // `assertOwnerOrApprover` refuses a non-owner without `workforce.approve`: "this record belongs to
    // another employee". A colleague's draft is only visible at all to a `workforce.read` holder, and
    // pushing it through on their behalf is an administrator's act.
    renderTab([THEIR_DRAFT]);
    await screen.findByText('Their draft');

    expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull();
  });
});

describe('the Timesheets tab, for a reviewer', () => {
  it('offers Approve and Reject on a colleague’s submitted sheet', async () => {
    viewer.permissions = ['workforce.approve'];
    renderTab([SUBMITTED]);
    await screen.findByText('Colleague sheet');

    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy();
  });

  it('withholds them on the reviewer’s own sheet, even holding the wildcard', async () => {
    /*
     * The one gate here that is stricter than the API rather than a mirror of it: `reviewTimesheet` has no
     * separation-of-duties check, so this click would in fact succeed. It is withheld because a timesheet
     * is what payroll is computed from and self-approval is refused on every other decision in the
     * product. Asserted with `'*'` so the rule cannot be satisfied by permissions alone.
     */
    viewer.permissions = ['*'];
    renderTab([MINE_SUBMITTED]);
    await screen.findByText('My submitted sheet');

    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.getByText('Yours — a colleague decides')).toBeTruthy();
  });

  it('submits somebody else’s draft on their behalf, which workforce.approve allows', async () => {
    // The approver branch of `assertOwnerOrApprover`. Asserted next to the refusal above so that
    // "gated" and "removed" cannot be confused.
    viewer.permissions = ['workforce.approve'];
    renderTab([THEIR_DRAFT]);
    await screen.findByText('Their draft');

    expect(screen.getByRole('button', { name: 'Submit' })).toBeTruthy();
  });

  it('offers nothing, and explains nothing, once the sheet is decided', async () => {
    // `TIMESHEET_NOT_EDITABLE`: only a submitted sheet can be reviewed, only a draft submitted.
    viewer.permissions = ['*'];
    renderTab([{ ...BASE, id: 'ts-5', status: 'approved', note: 'Signed off' }]);
    await screen.findByText('Signed off');

    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull();
    expect(screen.queryByText(/colleague decides|Not yours/)).toBeNull();
  });
});

describe('the Timesheets tab detail drawer', () => {
  /*
   * The drawer header repeats Submit, Approve and Reject, gated independently of the table — so gating only
   * the table would have left the hole open one click away.
   */
  it('offers the decision to a reviewer and withholds it on their own sheet', async () => {
    viewer.permissions = ['*'];
    renderTab([SUBMITTED, MINE_SUBMITTED]);
    await screen.findByText('Colleague sheet');

    fireEvent.click(screen.getByText('Colleague sheet'));
    const colleagues = screen.getByRole('dialog');
    expect(within(colleagues).getByRole('button', { name: 'Approve' })).toBeTruthy();
    // And NOT Submit: a sheet already awaiting a decision cannot be submitted again
    // (`TIMESHEET_NOT_EDITABLE`), and this is what keeps the drawer's Submit gate from being dropped.
    expect(within(colleagues).queryByRole('button', { name: 'Submit' })).toBeNull();

    fireEvent.click(screen.getByText('My submitted sheet'));
    const own = screen.getByRole('dialog');
    expect(within(own).queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(within(own).getByText('Yours — a colleague decides')).toBeTruthy();
  });

  it('offers Submit on the owner’s own draft with no permission at all', async () => {
    renderTab([MINE_DRAFT]);
    await screen.findByText('My draft sheet');

    fireEvent.click(screen.getByText('My draft sheet'));
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Submit' })).toBeTruthy();
  });
});
