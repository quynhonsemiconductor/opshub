// @vitest-environment jsdom
/**
 * WHO IS OFFERED A DECISION ON A LEAVE REQUEST — asserted, because the tab used to offer one to everybody.
 *
 * WHY THIS FILE EXISTS AND WHY IT IS NOT A BROWSER TEST. All eight Playwright seats are seeded admins
 * holding the `'*'` wildcard, so a caller who holds nothing is a tier the browser suite cannot represent —
 * which is exactly how ~30 ungated action sites across the four workforce tabs went unnoticed. The same
 * blind spot hid the nav gating (`widgets/app-shell/nav-groups.spec.tsx`) and the request withdraw rule
 * (`pages/requests/request-policy.spec.ts`); this is the third instance of one gap.
 *
 * WHAT IS BEING PINNED, in the API's own terms:
 *   - `POST /leave/:id/review` requires `workforce.approve` at the route guard AND
 *     `workforce.leave.review` inside the engine (`LeaveRequestTypeDef.requiredApprovalPermission`), so a
 *     holder of one and not the other is allowed to call and then refused mid-transaction.
 *   - `allowSelfApproval: false` means nobody decides their own request — `REQUEST_SOD_VIOLATION` — so the
 *     button on your own row could only ever fail.
 *   - `POST /leave` and `POST /leave/:id/cancel` are self-service (`@SelfScoped` and
 *     `assertOwnerOrApprover`). Gating THOSE would be a new defect, so they are asserted present for a
 *     caller with no permissions at all.
 *
 * The assertions are on roles and visible text, not on the policy functions, because "sees a button" is
 * the claim that was false.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const GET = vi.fn();
const POST = vi.fn();

vi.mock('@/shared/api/client', () => ({
  api: { GET: (...a: unknown[]) => GET(...a), POST: (...a: unknown[]) => POST(...a) },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/*
 * THE CLOCK IS FAKE, and it is not ceremony — see `shared/ui/date-range-picker.spec.tsx`. The date
 * filter's calendar opens on the month holding TODAY, and the day the filter test clicks (`4 March
 * 2026`) exists only in March. `setSystemTime` alone mocks the Date — the real timers keep running,
 * which is what React Query's queries and Testing Library's `findBy*` polling need; faking the
 * timers would stall both.
 */
vi.setSystemTime(new Date('2026-03-10T12:00:00'));

/**
 * The viewer, mutated per test: their id decides ownership and their permission list decides everything
 * else. Both hooks are stubbed rather than seeded through `/me` so that a test can hold ONE of the two
 * review permissions — the split the seeded roles cannot express, since `hr` and `manager` hold both.
 */
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
// The drawer's activity feed fetches on open, and what is under test is the header actions above it.
vi.mock('@/shared/ui/activity-timeline', () => ({ ActivityTimeline: () => null }));

import { LeaveTab } from './leave-tab';

const PENDING = {
  id: 'leave-1',
  employeeId: 'emp-colleague',
  leaveType: 'annual',
  startDate: '2026-03-02',
  endDate: '2026-03-03',
  startPortion: 'full_day',
  endPortion: 'full_day',
  workingDays: '2.00',
  reason: 'Family trip',
  status: 'pending',
  requestId: 'req-1',
  reviewerId: null,
  reviewedAt: null,
  createdAt: '2026-02-20T09:00:00.000Z',
};

/** The same request, raised by the viewer. Separation of duties turns on exactly this one field. */
const MINE = { ...PENDING, id: 'leave-2', employeeId: 'emp-me', reason: 'Dentist' };

const APPROVED = { ...PENDING, id: 'leave-3', status: 'approved', reason: 'Conference' };

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
      <LeaveTab />
    </QueryClientProvider>,
  );
}

/** Opens the detail drawer by clicking the row, which is how a user gets to the second set of controls. */
function openDrawer(rowText: string) {
  fireEvent.click(screen.getByText(rowText));
  return screen.getByRole('dialog');
}

/**
 * Sets a range through the picker the way a keyboard does it: the first pick is a calendar click
 * (nothing has been committed yet, so typing cannot work — see the picker's own spec), the second
 * end is typed into the To field, which commits the ordered pair. Same helper as
 * `timesheets-tab.spec.tsx`; not shared because the picker interaction is not the thing under test.
 */
async function pickRange(scope: HTMLElement, from: string, to: string) {
  const fromField = within(scope).getByLabelText('From date') as HTMLInputElement;
  fromField.focus();
  fireEvent.focus(fromField);
  const calendar = within(scope).getByRole('dialog', { name: 'Choose date range' });
  fireEvent.click(within(calendar).getByRole('button', { name: from }));
  fireEvent.change(within(scope).getByLabelText('To date'), { target: { value: to } });
}

beforeEach(() => {
  vi.clearAllMocks();
  viewer.sub = 'emp-me';
  viewer.permissions = [];
});

describe('the Leave tab, for an employee who holds no permissions', () => {
  it('offers no decision on their own request, and says who makes it', async () => {
    /*
     * THE DEFECT THIS FILE WAS WRITTEN FOR. `ROLE.EMPLOYEE` holds no permission codes at all — the
     * catalogue says self-service is expressed by scope, not by a code — and the list narrows to the
     * caller, so every row an employee saw was their own and every one carried Approve and Reject. Both
     * were guaranteed 403s: the route guard has no `workforce.approve` to find, and the engine would
     * refuse the self-approval even if it did.
     */
    renderTab([MINE]);
    await screen.findByText('Dentist');

    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
    // Not a blank cell: "ask a colleague" is the next action, and the requests inbox already says it
    // this way for the same fact about the same request.
    expect(screen.getByText('Yours — a colleague decides')).toBeTruthy();
  });

  it('still offers the two self-service actions, which need no permission', async () => {
    /*
     * THE OTHER HALF OF THE GATE, and the more dangerous one to get wrong: filing leave is `@SelfScoped`
     * and withdrawing it is `assertOwnerOrApprover`, which passes the owner on identity alone. Gating
     * either on a permission would take the whole leave journey away from most of the organisation —
     * a worse bug than the one being fixed, and one no admin seat would ever reveal.
     */
    renderTab([MINE]);
    await screen.findByText('Dentist');

    expect(screen.getByRole('button', { name: /request leave/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });
});

describe('the Leave tab, for a reviewer', () => {
  it('offers Approve and Reject on a colleague’s pending request', async () => {
    // The positive case has to be asserted next to the negatives, or "gated" and "removed" look the same.
    viewer.permissions = ['workforce.approve', 'workforce.leave.review'];
    renderTab([PENDING]);
    await screen.findByText('Family trip');

    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy();
    expect(screen.queryByText(/colleague decides|Not yours/)).toBeNull();
  });

  it('withholds them on the reviewer’s own request, however much they hold', async () => {
    /*
     * `allowSelfApproval: false`. The wildcard is deliberate here: a super-admin passes every permission
     * check and is still refused by the engine, so this is the one case where holding MORE changes
     * nothing. Without this assertion the gate could be written as a permission check alone and every
     * other test in this file would still pass.
     */
    viewer.permissions = ['*'];
    renderTab([MINE]);
    await screen.findByText('Dentist');

    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
    expect(screen.getByText('Yours — a colleague decides')).toBeTruthy();
    // And they can still WITHDRAW it, because that is the owner's own act rather than a decision.
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  it('withholds them from a holder of workforce.approve alone, which the engine refuses', async () => {
    /*
     * THE HALF-PERMISSION CASE. `workforce.approve` satisfies `@RequirePermission` on the route, so this
     * caller gets a 200-shaped request all the way into `RequestEngineService.approve`, which then checks
     * `LeaveRequestTypeDef.requiredApprovalPermission` — `workforce.leave.review` — and throws. Gating on
     * the route's permission alone would leave a button that fails after doing work.
     */
    viewer.permissions = ['workforce.approve'];
    renderTab([PENDING]);
    await screen.findByText('Family trip');

    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.getByText('Not yours to decide')).toBeTruthy();
  });

  it('offers nothing, and explains nothing, once the request is decided', async () => {
    // `LEAVE_REQUEST_NOT_PENDING`. The status gate comes first, so even the wildcard holder gets nothing —
    // and no sentence either, because there is nothing to explain about a finished record.
    viewer.permissions = ['*'];
    renderTab([APPROVED]);
    await screen.findByText('Conference');

    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(screen.queryByText(/colleague decides|Not yours/)).toBeNull();
  });
});

describe('the Leave tab detail drawer', () => {
  /*
   * THE SECOND SET OF THE SAME THREE BUTTONS. The drawer header repeats Approve, Reject and Cancel, gated
   * independently of the table — so gating only the table would have left the whole hole open one click
   * away. Each of the three header gates is mutation-checked by one of the four tests below.
   */
  it('offers the decision to a reviewer looking at a colleague’s request', async () => {
    viewer.permissions = ['workforce.approve', 'workforce.leave.review'];
    renderTab([PENDING]);
    await screen.findByText('Family trip');

    const drawer = openDrawer('Family trip');
    expect(within(drawer).getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(within(drawer).getByRole('button', { name: 'Reject' })).toBeTruthy();
  });

  it('withholds it from an employee looking at their own request', async () => {
    renderTab([MINE]);
    await screen.findByText('Dentist');

    const drawer = openDrawer('Dentist');
    expect(within(drawer).queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(within(drawer).queryByRole('button', { name: 'Reject' })).toBeNull();
    expect(within(drawer).getByText('Yours — a colleague decides')).toBeTruthy();
    // Withdrawing is still theirs to do, from here as well as from the row.
    expect(within(drawer).getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  it('does not offer to withdraw a colleague’s request', async () => {
    /*
     * `assertOwnerOrApprover` again, in the drawer: a reader who can SEE somebody else's leave —
     * `workforce.read` is enough for that, and it is what an auditor holds — is not the person who may
     * take it back. Without this the drawer's Cancel gate can be dropped entirely and everything else in
     * this file still passes, because the only other rows reaching the header are ones the viewer either
     * owns or may approve. It is the sentence that renders instead, and nothing else.
     */
    viewer.permissions = ['workforce.read'];
    renderTab([PENDING]);
    await screen.findByText('Family trip');

    const drawer = openDrawer('Family trip');
    expect(within(drawer).queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(within(drawer).getByText('Not yours to decide')).toBeTruthy();
  });

  it('offers nothing at all on a decided request, to a wildcard holder', async () => {
    /*
     * The status gate, which comes before everything about the caller: "Cancel" on a request that was
     * approved last month would be answered `LEAVE_REQUEST_NOT_PENDING`, and there is nothing to explain
     * about a finished record, so the header row is not rendered at all rather than rendered empty.
     */
    viewer.permissions = ['*'];
    renderTab([APPROVED]);
    await screen.findByText('Conference');

    const drawer = openDrawer('Conference');
    expect(within(drawer).queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(within(drawer).queryByRole('button', { name: 'Reject' })).toBeNull();
    expect(within(drawer).queryByRole('button', { name: 'Cancel' })).toBeNull();
  });
});

describe('the Leave tab, before /me has resolved', () => {
  it('shows neither a control nor an explanation, rather than guessing', async () => {
    /*
     * Ownership is unknowable without the viewer's id, and a control that flickers into existence a
     * moment after the page settles is worse than one that appears a moment late. A sentence would be
     * worse still: "Not yours to decide" flashing on a manager's own queue is a claim, not a placeholder.
     */
    viewer.sub = undefined;
    viewer.permissions = ['*'];
    renderTab([PENDING]);
    await screen.findByText('Family trip');

    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByText(/colleague decides|Not yours/)).toBeNull();
  });
});

describe('the list date-range filter', () => {
  it('asks "starting between", the API’s own semantics, and sends the window as dateFrom/dateTo', async () => {
    /*
     * The leave list filters on `startDate` — a request whose window BEGINS in the range — and not as
     * an overlap test, so a trip straddling the boundary is deliberately not matched. The label says
     * that out loud, because a generic "between" would promise the overlap reading the API does not
     * give. Clearing goes back to `undefined`s, which share one cache entry with a never-set filter.
     */
    renderTab([]);
    await screen.findByText('No leave records found');

    expect(screen.getByText('Starting between')).toBeTruthy();

    await pickRange(document.body, '4 March 2026', '2026-03-11');

    await waitFor(() => {
      const query = GET.mock.calls.at(-1)![1].params.query;
      expect(query.dateFrom).toBe('2026-03-04');
      expect(query.dateTo).toBe('2026-03-11');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Clear dates' }));
    await waitFor(() => {
      const query = GET.mock.calls.at(-1)![1].params.query;
      expect(query.dateFrom).toBeUndefined();
      expect(query.dateTo).toBeUndefined();
    });
  });
});

describe('the empty state', () => {
  it('offers the same action as the toolbar, and withdraws it once a filter narrows the list', async () => {
    /*
     * An empty table under no filter is "nothing filed yet" — the moment to offer the one action the
     * toolbar already carries. Under a filter the same blank means "nothing matches this", and
     * "request leave" stops being the answer, so the toolbar button is left as the only offer.
     *
     * Distinct names from the toolbar button — sharing one made `getByRole` ambiguous for anything
     * targeting just the header action, e2e specs included.
     */
    renderTab([]);
    await screen.findByText('No leave records found');
    expect(screen.getByRole('button', { name: /^Request leave$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Request your first leave/i })).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: 'Pending' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Request your first leave/i })).toBeNull(),
    );
    expect(screen.getByRole('button', { name: /^Request leave$/ })).toBeTruthy();
  });
});
