// @vitest-environment jsdom
/**
 * WHO MAY RUN A REVIEW CYCLE, versus who may only look at whether it worked.
 *
 * THIS IS THE PERSONA THE SCREEN WAS BUILT FOR, and it was the one getting dead buttons. `ROLE.MANAGER`
 * holds `performance.read` and NOT `performance.manage` (`db/permissions.catalog.ts`), and a People
 * Manager is exactly who the coverage report is written for: "did my team get reviewed" is not
 * answerable from the review list, because the people missing from it are the answer. Every read behind
 * that report — `GET cycles`, `GET cycles/{id}/progress`, `GET cycles/{id}/coverage` — asks for
 * `performance.read`, so the manager belongs here. All four writes — `POST cycles`,
 * `POST cycles/{id}/open`, `POST cycles/{id}/close`, `POST cycles/{id}/reviews` — carry
 * `@RequirePermission(PERMISSION.PERFORMANCE_MANAGE)`. So the manager was shown four controls, of which
 * zero worked, on the one page that exists for them.
 *
 * WHY NO BROWSER TEST COULD HAVE CAUGHT IT. All eight Playwright seats are administrators and hold the
 * manage code, so the suite renders this tab in one state only. Note also that `ROLE.AUDITOR` holds no
 * `performance.read` at all — deliberately, a review being a personal judgement — so unlike the training
 * tabs there is exactly one read-only tier here, and it is the manager.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const GET = vi.fn();

vi.mock('@/shared/api/client', () => ({
  api: { GET: (...a: unknown[]) => GET(...a), POST: vi.fn() },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/** Exact-key matching: `can: () => true` would let a component gate on the wrong code and still pass. */
let held: string[] = [];
vi.mock('@/shared/hooks/use-permissions', () => ({
  usePermissions: () => ({ can: (key: string) => held.includes(key) }),
}));

import { CyclesTab } from './cycles-tab';

const CYCLE = {
  id: 'cycle-1',
  reference: 'PC-2026-H1',
  name: 'First half 2026',
  periodStart: '2026-01-01',
  periodEnd: '2026-06-30',
  selfAssessmentDue: '2026-07-07',
  reviewDue: '2026-07-21',
  // Widened, because the draft case substitutes both by spread and TypeScript would otherwise pin them
  // to the literal types `'open'` and `string`.
  status: 'open' as string,
  openedAt: '2026-01-02T09:00:00.000Z' as string | null,
  closedAt: null as string | null,
  createdAt: '2025-12-15T09:00:00.000Z',
};

const GAP = {
  employeeId: '019fff6b-0000-7fac-8f5e-000000000009',
  employeeName: 'Dana Okonkwo',
  email: 'dana@example.com',
  status: null,
};

/** One GET mock routed on the path: the drawer reads progress and coverage on top of the list. */
function routeGet(cycle: Record<string, unknown>) {
  GET.mockImplementation((path: string) => {
    if (path === '/v1/performance/cycles') {
      return Promise.resolve({
        data: { data: [cycle], pageInfo: { total: 1, limit: 25, offset: 0, hasNextPage: false } },
        error: undefined,
      });
    }
    if (path === '/v1/performance/cycles/{id}/progress') {
      return Promise.resolve({ data: [{ status: 'manager_review', count: 3 }], error: undefined });
    }
    if (path === '/v1/performance/cycles/{id}/coverage') {
      return Promise.resolve({
        data: { data: [GAP], pageInfo: { total: 1, limit: 25, offset: 0, hasNextPage: false } },
        error: undefined,
      });
    }
    // The drawer's activity timeline.
    return Promise.resolve({
      data: { data: [], pageInfo: { total: 0, limit: 25, offset: 0, hasNextPage: false } },
      error: undefined,
    });
  });
}

function renderAs(permissions: string[], cycle = CYCLE) {
  held = permissions;
  routeGet(cycle);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CyclesTab />
    </QueryClientProvider>,
  );
}

describe('CyclesTab', () => {
  beforeEach(() => vi.clearAllMocks());

  it('gives a performance.read-only manager the coverage report and no write control', async () => {
    const { container } = renderAs(['performance.read']);

    expect(await screen.findByText('First half 2026')).toBeTruthy();
    expect(screen.getByText('PC-2026-H1')).toBeTruthy();

    /*
     * ALL FOUR WRITES WITHHELD. Named individually rather than counted, because they are four different
     * routes and a partial fix — the toolbar gated and the row left open, which is how the drawer's own
     * "Add a review" survived a previous correction — would pass a count.
     */
    expect(screen.queryByRole('button', { name: 'New cycle' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
    expect(screen.queryByRole('button', { name: `Add a review to ${CYCLE.reference}` })).toBeNull();

    /*
     * AND THE REPORT STILL WORKS, which is the whole reason the manager is on this page. A gate that
     * hid the drawer along with the buttons would have passed every assertion above and taken away the
     * one thing this tier came for — so the positive half is asserted in the same breath.
     */
    fireEvent.click(container.querySelector('[data-row-id="cycle-1"]')!);
    expect(await screen.findByText('Dana Okonkwo')).toBeTruthy();
    // `status: null` means no review at all, which is a different problem from one that stalled.
    expect(screen.getByText('No review')).toBeTruthy();
    expect(screen.getByText('Not covered (1)')).toBeTruthy();
    // And the drawer's own copy of the write action is gone too, not just the row's.
    expect(screen.queryByRole('button', { name: 'Add a review' })).toBeNull();
  });

  it('offers the cycle transitions to a performance.manage holder', async () => {
    const { container } = renderAs(['performance.read', 'performance.manage']);

    await screen.findByText('First half 2026');
    /*
     * The positive tier. Without it, deleting the four controls would satisfy the case above — this is
     * what makes the pair a gate rather than a feature removal.
     */
    expect(screen.getByRole('button', { name: 'New cycle' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
    expect(screen.getByRole('button', { name: `Add a review to ${CYCLE.reference}` })).toBeTruthy();

    // The drawer offers it too, on an OPEN cycle.
    fireEvent.click(container.querySelector('[data-row-id="cycle-1"]')!);
    expect(await screen.findByRole('button', { name: 'Add a review' })).toBeTruthy();
  });

  it('still follows the cycle state machine for a manage holder', async () => {
    const { container } = renderAs(['performance.read', 'performance.manage'], {
      ...CYCLE,
      status: 'draft',
      openedAt: null,
    });

    await screen.findByText('First half 2026');
    /*
     * PERMISSION AND STATE ARE SEPARATE AXES. A draft cycle can be opened and cannot be closed, and
     * `createReview` refuses anything but an OPEN cycle — with a message naming the state. Adding the
     * permission check must not have flattened those conditions into it, or a manage holder gets an
     * Add-a-review button on a draft whose only outcome is a refusal no screen had mentioned.
     */
    expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
    expect(screen.queryByRole('button', { name: `Add a review to ${CYCLE.reference}` })).toBeNull();

    /*
     * AND THE DRAWER AGREES WITH THE ROW. This is the assertion for a bug that was half-fixed: the row
     * was corrected from `!== 'closed'` to `=== 'open'` and the drawer header was left reading the old
     * rule, so the very refusal the row's comment describes survived at the second entry point to the
     * same route. Two paths to one endpoint have to be gated together or neither is gated.
     */
    fireEvent.click(container.querySelector('[data-row-id="cycle-1"]')!);
    await screen.findByText('Not covered (1)');
    expect(screen.queryByRole('button', { name: 'Add a review' })).toBeNull();
  });
});
