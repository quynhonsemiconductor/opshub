// @vitest-environment jsdom
/**
 * WHO IS OFFERED A DECISION ON AN OVERTIME ENTRY.
 *
 * The same gap as the Leave tab and the same reason it survived: every Playwright seat is a seeded admin,
 * so a caller holding nothing — which is precisely what `ROLE.EMPLOYEE` holds — is a tier no browser test
 * can render. See `leave-tab.spec.tsx` for the full account.
 *
 * WHAT IS DIFFERENT HERE, and why this is not a copy of that file rather than a shared helper: the pair of
 * permissions is `workforce.approve` (route guard) plus `workforce.overtime.review`
 * (`OvertimeTypeDef.requiredApprovalPermission`), and the stakes are higher — overtime is PAID work, so a
 * self-approval that slipped through is a payment authorised by its own beneficiary. `allowSelfApproval` is
 * false on that type def for exactly that reason.
 *
 * There is no Cancel here: the API exposes no `overtime/:id/cancel`, so logging and deciding are the only
 * two acts, and logging is `@SelfScoped` and stays open to everybody.
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

/** Mutated per test. Stubbed rather than seeded through `/me` so one review code can be held alone. */
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

import { OvertimeTab } from './overtime-tab';

const PENDING = {
  id: 'ot-1',
  employeeId: 'emp-colleague',
  workDate: '2026-03-02',
  hours: '3.00',
  reason: 'Release night',
  status: 'pending',
  requestId: 'req-1',
  reviewerId: null,
  reviewedAt: null,
  createdAt: '2026-03-03T09:00:00.000Z',
};

/** The same entry, logged by the viewer — the one field separation of duties turns on. */
const MINE = { ...PENDING, id: 'ot-2', employeeId: 'emp-me', reason: 'Incident bridge' };

const APPROVED = { ...PENDING, id: 'ot-3', status: 'approved', reason: 'Migration window' };

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
      <OvertimeTab />
    </QueryClientProvider>,
  );
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

describe('the Overtime tab, for an employee who holds no permissions', () => {
  it('offers no decision on their own entry, and says who makes it', async () => {
    renderTab([MINE]);
    await screen.findByText('Incident bridge');

    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
    expect(screen.getByText('Yours — a colleague decides')).toBeTruthy();
  });

  it('still offers logging overtime, which is self-service and needs no permission', async () => {
    // `POST /overtime` is `@SelfScoped` — `employeeId` is the actor. Hiding this would remove the only
    // thing an employee comes to this tab to do.
    renderTab([MINE]);
    await screen.findByText('Incident bridge');

    expect(screen.getByRole('button', { name: /log overtime/i })).toBeTruthy();
  });
});

describe('the Overtime tab, for a reviewer', () => {
  it('offers Approve and Reject on a colleague’s pending entry', async () => {
    viewer.permissions = ['workforce.approve', 'workforce.overtime.review'];
    renderTab([PENDING]);
    await screen.findByText('Release night');

    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy();
  });

  it('withholds them on the reviewer’s own entry, even holding the wildcard', async () => {
    // Approving the hours you are paid for is the act `allowSelfApproval: false` exists to stop, and no
    // amount of permission changes it. Written with `'*'` so the gate cannot be satisfied by permissions.
    viewer.permissions = ['*'];
    renderTab([MINE]);
    await screen.findByText('Incident bridge');

    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.getByText('Yours — a colleague decides')).toBeTruthy();
  });

  it('withholds them from a holder of workforce.approve alone, which the engine refuses', async () => {
    // Past the route guard, refused by `OvertimeTypeDef.requiredApprovalPermission` inside the
    // transaction. The seeded roles hold both codes, so only a hand-built role reaches this state.
    viewer.permissions = ['workforce.approve'];
    renderTab([PENDING]);
    await screen.findByText('Release night');

    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.getByText('Not yours to decide')).toBeTruthy();
  });

  it('offers nothing, and explains nothing, once the entry is decided', async () => {
    viewer.permissions = ['*'];
    renderTab([APPROVED]);
    await screen.findByText('Migration window');

    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByText(/colleague decides|Not yours/)).toBeNull();
  });
});

describe('the Overtime tab detail drawer', () => {
  /*
   * The drawer header carries its own copy of Approve and Reject, gated independently of the table, so
   * gating only the table would leave the hole open one click away.
   */
  it('offers the decision to a reviewer and withholds it on their own entry', async () => {
    viewer.permissions = ['*'];
    renderTab([PENDING, MINE]);
    await screen.findByText('Release night');

    fireEvent.click(screen.getByText('Release night'));
    const colleagues = screen.getByRole('dialog');
    expect(within(colleagues).getByRole('button', { name: 'Approve' })).toBeTruthy();

    fireEvent.click(screen.getByText('Incident bridge'));
    const own = screen.getByRole('dialog');
    expect(within(own).queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(within(own).getByText('Yours — a colleague decides')).toBeTruthy();
  });
});

describe('the list date-range filter', () => {
  it('filters on workDate — "worked between", the timesheets tab’s own question — and sends dateFrom/dateTo', async () => {
    /*
     * Unlike leave (which filters on when a window BEGINS), overtime filters on the plain `workDate`
     * the row is about, so the label reads the same as the timesheets tab's for the same column.
     * Clearing goes back to `undefined`s, which share one cache entry with a never-set filter.
     */
    renderTab([]);
    await screen.findByText('No overtime records found');

    expect(screen.getByText('Worked between')).toBeTruthy();

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
     * An empty table under no filter is "nothing logged yet" — the moment to offer the one action the
     * toolbar already carries. Under a filter the same blank means "nothing matches this", and
     * "log overtime" stops being the answer, so the toolbar button is left as the only offer.
     *
     * Distinct names from the toolbar button — sharing one made `getByRole` ambiguous for anything
     * targeting just the header action, e2e specs included.
     */
    renderTab([]);
    await screen.findByText('No overtime records found');
    expect(screen.getByRole('button', { name: /^Log overtime$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Log your first overtime/i })).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: 'Pending' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Log your first overtime/i })).toBeNull(),
    );
    expect(screen.getByRole('button', { name: /^Log overtime$/ })).toBeTruthy();
  });
});
