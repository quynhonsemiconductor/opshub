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
 *
 * The later describes pin the three-mode log form, the bulk review loop and the list's date filter —
 * all of which answer the clock or the query string, which is why the clock is pinned below.
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
 * THE CLOCK IS FAKE, and it is not ceremony — see `shared/ui/date-range-picker.spec.tsx`. The log form
 * defaults its date to TODAY, the range picker opens its calendar on the month holding TODAY, and the
 * calendar days the tests click (`4 March 2026`) exist only in March. `setSystemTime` alone mocks the
 * Date — the real timers keep running, which is what React Query's queries and Testing Library's
 * `findBy*` polling below need; faking the timers would stall both.
 */
vi.setSystemTime(new Date('2026-03-10T12:00:00'));

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
import { toast } from 'sonner';

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

/** Every call to a given path, unwrapped from the client mock. */
const callsTo = (path: string) => POST.mock.calls.filter((call) => call[0] === path);

/** Opens the log form and hands back the dialog element. */
async function openLogForm() {
  fireEvent.click(await screen.findByRole('button', { name: /log timesheet/i }));
  return screen.getByRole('dialog');
}

/**
 * Sets a range through the picker the way a keyboard does it: the first pick is a calendar click
 * (nothing has been committed yet, so typing cannot work — see the picker's own spec), the second
 * end is typed into the To field, which commits the ordered pair.
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
  POST.mockResolvedValue({ data: {}, error: undefined });
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
    // And no bulk selection either: checkboxes leading to a bar of 403s are not self-service.
    expect(screen.queryByLabelText('Select row')).toBeNull();
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

describe('the Log timesheet form, single-day mode', () => {
  it('defaults the work date to today and logs through the presets', async () => {
    renderTab([MINE_DRAFT]);
    const modal = await openLogForm();

    // THE DEFAULT THE AUDIT FLAGGED. The old form opened on an empty required date and made the
    // ordinary case — logging today — start with an error.
    const date = within(modal).getByLabelText(/^Work date/) as HTMLInputElement;
    expect(date.value).toBe('2026-03-10');

    fireEvent.click(within(modal).getByRole('button', { name: '4h' }));
    fireEvent.click(within(modal).getByRole('button', { name: 'Log' }));

    await waitFor(() => expect(callsTo('/v1/workforce/timesheets')).toHaveLength(1));
    expect(callsTo('/v1/workforce/timesheets')[0][1].body).toEqual({
      workDate: '2026-03-10',
      minutesWorked: 240,
      note: undefined,
    });
    expect(toast.success).toHaveBeenCalledWith('Timesheet logged');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('refuses a missing work date inline, announced — the browser is not asked', async () => {
    renderTab([MINE_DRAFT]);
    const modal = await openLogForm();

    const date = within(modal).getByLabelText(/^Work date/) as HTMLInputElement;
    fireEvent.change(date, { target: { value: '' } });
    fireEvent.click(within(modal).getByRole('button', { name: 'Log' }));

    expect(within(modal).getByRole('alert')).toHaveTextContent('Work date is required.');
    expect(date).toHaveAttribute('aria-invalid', 'true');
    expect(callsTo('/v1/workforce/timesheets')).toHaveLength(0);
    // A failed submit does not close the form over the thing that needs fixing.
    expect(screen.getByRole('dialog', { name: 'Log timesheet' })).toBeTruthy();
  });

  it('lets a complete start/end pair own the minutes, overnight spans included', async () => {
    renderTab([MINE_DRAFT]);
    const modal = await openLogForm();

    fireEvent.click(within(modal).getByRole('checkbox', { name: /^Add start and end time/ }));
    fireEvent.change(within(modal).getByLabelText('Start time'), { target: { value: '22:00' } });
    fireEvent.change(within(modal).getByLabelText('End time'), { target: { value: '06:00' } });

    // The readout, in `formatDuration`'s one spelling — and the number field is now the pair's.
    expect(within(modal).getByText('Derived from the times: 8h')).toBeTruthy();
    const hours = within(modal).getByLabelText('Time worked, hours') as HTMLInputElement;
    expect(hours).toBeDisabled();
    expect(hours.value).toBe('8');

    fireEvent.click(within(modal).getByRole('button', { name: 'Log' }));
    await waitFor(() => expect(callsTo('/v1/workforce/timesheets')).toHaveLength(1));
    expect(callsTo('/v1/workforce/timesheets')[0][1].body).toMatchObject({
      minutesWorked: 480,
      startTime: '22:00',
      endTime: '06:00',
    });
  });

  it('refuses end === start inline, with the sentence the API would send', async () => {
    renderTab([MINE_DRAFT]);
    const modal = await openLogForm();

    fireEvent.click(within(modal).getByRole('checkbox', { name: /^Add start and end time/ }));
    fireEvent.change(within(modal).getByLabelText('Start time'), { target: { value: '09:00' } });
    fireEvent.change(within(modal).getByLabelText('End time'), { target: { value: '09:00' } });
    fireEvent.click(within(modal).getByRole('button', { name: 'Log' }));

    expect(within(modal).getByRole('alert')).toHaveTextContent(
      'Start and end must differ — equal times describe a zero-minute shift.',
    );
    expect(callsTo('/v1/workforce/timesheets')).toHaveLength(0);
    expect(screen.getByRole('dialog', { name: 'Log timesheet' })).toBeTruthy();
  });

  it('renders the API’s own refusal inline and stays open', async () => {
    POST.mockResolvedValue({ error: { error: { message: 'That day is already logged.' } } });
    renderTab([MINE_DRAFT]);
    const modal = await openLogForm();

    fireEvent.click(within(modal).getByRole('button', { name: 'Log' }));
    await waitFor(() => expect(callsTo('/v1/workforce/timesheets')).toHaveLength(1));

    expect(within(modal).getByRole('alert')).toHaveTextContent('That day is already logged.');
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('the Log timesheet form, bulk modes', () => {
  it('switches modes without losing the shared fields, and says what each does', async () => {
    renderTab([]);
    await screen.findByText('No timesheets found');
    const modal = await openLogForm();

    expect(within(modal).getByText('One day, one draft.')).toBeTruthy();
    fireEvent.click(within(modal).getByRole('radio', { name: 'Date range' }));

    expect(
      within(modal).getByText('One draft per day in the window — weekends included.'),
    ).toBeTruthy();
    expect(within(modal).getByLabelText('From date')).toBeTruthy();
    // The single-day fields belong to the single-day mode only.
    expect(within(modal).queryByLabelText(/^Work date/)).toBeNull();
  });

  it('expands a range to one entry per day and chunks it through the bulk endpoint', async () => {
    renderTab([]);
    await screen.findByText('No timesheets found');
    const modal = await openLogForm();

    fireEvent.click(within(modal).getByRole('radio', { name: 'Date range' }));
    await pickRange(modal, '10 March 2026', '2026-07-07'); // 120 days, weekends included

    // The planned count is on the button and in the hint, in `formatDuration`'s spelling.
    expect(within(modal).getByText(/120 days · 8h each/)).toBeTruthy();
    fireEvent.click(within(modal).getByRole('button', { name: 'Log 120 days' }));

    // 120 drafts, in batches of ≤50, sent sequentially in date order.
    await waitFor(() => expect(callsTo('/v1/workforce/timesheets/bulk')).toHaveLength(3));
    const batches = callsTo('/v1/workforce/timesheets/bulk').map((call) => call[1].body.entries);
    expect(batches.map((entries: { workDate: string }[]) => entries.length)).toEqual([50, 50, 20]);
    expect(batches[0][0].workDate).toBe('2026-03-10');
    expect(batches[0][49].workDate).toBe('2026-04-28');
    expect(batches[1][0].workDate).toBe('2026-04-29');
    expect(batches[2][19].workDate).toBe('2026-07-07');

    expect(toast.success).toHaveBeenCalledWith('Logged 120 timesheets');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('keeps the form open and reports each refused batch by its dates', async () => {
    POST.mockImplementation(
      async (path: string, init: { body: { entries: { workDate: string }[] } }) => {
        if (path !== '/v1/workforce/timesheets/bulk') return { data: {}, error: undefined };
        // The second batch hits the rule — the first stays logged. Not fatal to the rest.
        return init.body.entries[0].workDate >= '2026-05-01'
          ? { error: { error: { message: 'One entry overlaps an existing draft.' } } }
          : { data: [], error: undefined };
      },
    );
    renderTab([]);
    await screen.findByText('No timesheets found');
    const modal = await openLogForm();

    fireEvent.click(within(modal).getByRole('radio', { name: 'Date range' }));
    await pickRange(modal, '4 March 2026', '2026-06-30'); // 119 days → 50 + 50 + 19
    fireEvent.click(within(modal).getByRole('button', { name: 'Log 119 days' }));

    await waitFor(() => expect(within(modal).getByText(/Logged 100 of 119/)).toBeTruthy());
    expect(within(modal).getAllByRole('alert').length).toBeGreaterThan(0);
    expect(
      within(modal).getByText(/2026-06-12 – 2026-06-30: One entry overlaps an existing draft./),
    ).toBeTruthy();
    // Partial success never closes the form over the days that were lost.
    expect(screen.getByRole('dialog', { name: 'Log timesheet' })).toBeTruthy();
  });

  it('expands a recurring pattern to the chosen weekdays only', async () => {
    renderTab([]);
    await screen.findByText('No timesheets found');
    const modal = await openLogForm();

    fireEvent.click(within(modal).getByRole('radio', { name: 'Recurring' }));
    // Monday to Friday pre-ticked — the chips ARE the weekend decision.
    expect(within(modal).getByRole('button', { name: 'Mo' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await pickRange(modal, '9 March 2026', '2026-03-15'); // a full week
    fireEvent.click(within(modal).getByRole('button', { name: 'Log 5 days' }));

    await waitFor(() => expect(callsTo('/v1/workforce/timesheets/bulk')).toHaveLength(1));
    const entries = callsTo('/v1/workforce/timesheets/bulk')[0][1].body.entries;
    expect(entries.map((entry: { workDate: string }) => entry.workDate)).toEqual([
      '2026-03-09',
      '2026-03-10',
      '2026-03-11',
      '2026-03-12',
      '2026-03-13',
    ]);
  });

  it('refuses a recurring week with no weekday ticked, before sending anything', async () => {
    renderTab([]);
    await screen.findByText('No timesheets found');
    const modal = await openLogForm();

    fireEvent.click(within(modal).getByRole('radio', { name: 'Recurring' }));
    for (const day of ['Mo', 'Tu', 'We', 'Th', 'Fr']) {
      fireEvent.click(within(modal).getByRole('button', { name: day }));
    }
    await pickRange(modal, '9 March 2026', '2026-03-15');
    fireEvent.click(within(modal).getByRole('button', { name: 'Log days' }));

    expect(within(modal).getByRole('alert')).toHaveTextContent('Pick at least one weekday.');
    expect(callsTo('/v1/workforce/timesheets/bulk')).toHaveLength(0);
    expect(screen.getByRole('dialog', { name: 'Log timesheet' })).toBeTruthy();
  });
});

describe('bulk review', () => {
  const selectRows = (count: number) => {
    for (let i = 0; i < count; i += 1) {
      // Re-query each time: a click re-renders the table and replaces the boxes.
      fireEvent.click(screen.getAllByLabelText('Select row')[i]);
    }
  };

  it('is offered to a reviewer with a count, and loops the row mutation over the selection', async () => {
    viewer.permissions = ['workforce.approve'];
    renderTab([SUBMITTED, { ...BASE, id: 'ts-9', note: 'Second sheet' }]);
    await screen.findByText('Colleague sheet');

    selectRows(2);
    const bar = screen.getByText('2 selected').closest('div') as HTMLElement;
    fireEvent.click(within(bar).getByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(callsTo('/v1/workforce/timesheets/{id}/review')).toHaveLength(2));
    const approvedIds = callsTo('/v1/workforce/timesheets/{id}/review').map(
      (call) => call[1].params.path.id,
    );
    expect(approvedIds).toEqual(['ts-1', 'ts-9']);
    // No bulk endpoint exists — the body is the row mutation's, once per id.
    for (const call of callsTo('/v1/workforce/timesheets/{id}/review')) {
      expect(call[1].body).toEqual({ approve: true });
    }
    expect(toast.success).toHaveBeenCalledWith('Approved 2, failed 0');
    // Only success empties the selection, and with it the bar.
    await waitFor(() => expect(screen.queryByText('2 selected')).toBeNull());
  });

  it('counts failures, keeps the failed rows selected and clears the ones that succeeded', async () => {
    viewer.permissions = ['workforce.approve'];
    POST.mockImplementation(async (path: string, init: { params: { path: { id: string } } }) => {
      if (path !== '/v1/workforce/timesheets/{id}/review') return { data: {}, error: undefined };
      return init.params.path.id === 'ts-9'
        ? { error: { error: { message: 'Already decided.' } } }
        : { data: {}, error: undefined };
    });
    renderTab([SUBMITTED, { ...BASE, id: 'ts-9', note: 'Second sheet' }]);
    await screen.findByText('Colleague sheet');

    selectRows(2);
    const bar = screen.getByText('2 selected').closest('div') as HTMLElement;
    fireEvent.click(within(bar).getByRole('button', { name: 'Reject' }));

    await waitFor(() => expect(callsTo('/v1/workforce/timesheets/{id}/review')).toHaveLength(2));
    expect(toast.success).toHaveBeenCalledWith('Rejected 1, failed 1');
    // The API's own sentence for the failure, not a paraphrase of it.
    expect(toast.error).toHaveBeenCalledWith('Already decided.');
    const boxes = screen.getAllByLabelText('Select row') as HTMLInputElement[];
    expect(boxes[0].checked).toBe(false); // ts-1 succeeded — unticked
    expect(boxes[1].checked).toBe(true); // ts-9 failed — still ticked, still to do
    expect(screen.getByText('1 selected')).toBeTruthy();
  });

  it('is not offered to an employee who cannot review, even on rows they could submit', async () => {
    renderTab([MINE_DRAFT, THEIR_DRAFT]);
    await screen.findByText('My draft sheet');

    expect(screen.queryByLabelText('Select row')).toBeNull();
    expect(screen.queryByText(/selected/)).toBeNull();
  });
});

describe('the list date-range filter', () => {
  it('sends the picked window as dateFrom/dateTo and clears back to nothing', async () => {
    renderTab([]);
    await screen.findByText('No timesheets found');

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
