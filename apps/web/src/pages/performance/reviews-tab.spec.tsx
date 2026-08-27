// @vitest-environment jsdom
/**
 * WHO MAY DO WHAT TO A PERFORMANCE REVIEW — four different rules on one screen, asserted apart.
 *
 * THIS TAB IS WHY "gate the write surfaces" IS NOT A SEARCH-AND-REPLACE. Read route by route, the
 * actions here fall into four groups and only one of them is a permission:
 *   · SUBJECT ONLY. `POST reviews/{id}/self-assessment` and `POST reviews/{id}/acknowledge` compare
 *     `review.employeeId` to `user.sub` and refuse everybody else — the controller states outright that
 *     `performance.manage` "does not help here", because a self-assessment written by somebody else is
 *     not one and an acknowledgement recorded by a third party is evidence of nothing. Gating these on a
 *     permission would hide the two things an ordinary employee comes to this page for: a new defect of
 *     the same class, pointing the other way.
 *   · ASSIGNED REVIEWER ONLY. `POST reviews/{id}/rating` and `POST reviews/{id}/submit` are enforced in
 *     the service on `reviewerId`. Also no permission code — a manager needs none to write the review
 *     they were given, and the manage code does not let anybody write somebody else's.
 *   · `performance.manage`. `PATCH reviews/{id}/reviewer` and `POST reviews/{id}/cancel`. THESE WERE THE
 *     UNGATED PAIR: every holder of `performance.read` was offered the power to move somebody else's
 *     review to a different reviewer, or withdraw it outright, from the drawer header.
 *   · REVIEWER **OR** `performance.manage`. `mustWriteReview` accepts either, so the goal routes are
 *     wider than the rating routes — HR sets a cycle's goals up and the reviewer refines them.
 *
 * WHY A COMPONENT TEST. Every Playwright seat is an administrator, so the browser suite can represent
 * neither a read-only manager nor a permission-less employee — and on the seeded data the admin seats
 * happen to be reviewers, which is what hid the goals rule being too NARROW at the same time as the
 * header rules were too wide.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const GET = vi.fn();

vi.mock('@/shared/api/client', () => ({
  api: { GET: (...a: unknown[]) => GET(...a), POST: vi.fn(), PATCH: vi.fn() },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/** Exact-key matching, so gating on the wrong permission cannot pass as gating on the right one. */
let held: string[] = [];
vi.mock('@/shared/hooks/use-permissions', () => ({
  usePermissions: () => ({ can: (key: string) => held.includes(key) }),
}));

// The employee/reviewer filter pickers fetch a directory of their own and answer no question this file
// asks; stubbed so every button found below belongs to the tab under test.
vi.mock('@/shared/ui', async () => {
  const real = await vi.importActual<typeof import('@/shared/ui')>('@/shared/ui');
  return { ...real, EntityPicker: () => null };
});

import { useAuthStore } from '@/shared/api/auth-store';
import { ReviewsTab } from './reviews-tab';

const ME = '019fff6b-0000-7fac-8f5e-000000000001';
const SUBJECT = '019fff6b-0000-7fac-8f5e-000000000002';
const REVIEWER = '019fff6b-0000-7fac-8f5e-000000000003';

const CYCLE = {
  id: 'cycle-1',
  reference: 'PC-2026-H1',
  name: 'First half 2026',
  periodStart: '2026-01-01',
  periodEnd: '2026-06-30',
  selfAssessmentDue: '2026-07-07',
  reviewDue: '2026-07-21',
  status: 'open',
  openedAt: '2026-01-02T09:00:00.000Z',
  closedAt: null,
  createdAt: '2025-12-15T09:00:00.000Z',
};

const REVIEW = {
  id: 'rev-1',
  cycleId: 'cycle-1',
  employeeId: SUBJECT,
  employeeName: 'Dana Okonkwo',
  reviewerId: REVIEWER,
  reviewerName: 'Sam Reyes',
  // Widened for the same reason as the other fixtures in this suite: the cases below move this review
  // through four statuses by spread, and literal inference would refuse every one of them.
  status: 'manager_review' as string,
  selfAssessment: 'I shipped the migration.',
  selfAssessmentSubmittedAt: '2026-07-05T09:00:00.000Z',
  managerSummary: null as string | null,
  overallRating: null as string | null,
  developmentPlan: null as string | null,
  ratedAt: null as string | null,
  acknowledgedAt: null as string | null,
  approvedAt: null as string | null,
  createdAt: '2026-07-01T09:00:00.000Z',
};

const GOAL = {
  id: 'goal-1',
  reviewId: 'rev-1',
  title: 'Ship the platform migration',
  description: null,
  target: 'Q2',
  weight: 100,
  outcome: null,
  rating: null,
};

function routeGet(review: Record<string, unknown>) {
  GET.mockImplementation((path: string) => {
    if (path === '/v1/performance/reviews') {
      return Promise.resolve({
        data: { data: [review], pageInfo: { total: 1, limit: 25, offset: 0, hasNextPage: false } },
        error: undefined,
      });
    }
    if (path === '/v1/performance/cycles/{id}') {
      return Promise.resolve({ data: CYCLE, error: undefined });
    }
    if (path === '/v1/performance/cycles') {
      return Promise.resolve({
        data: { data: [CYCLE], pageInfo: { total: 1, limit: 25, offset: 0, hasNextPage: false } },
        error: undefined,
      });
    }
    if (path === '/v1/performance/reviews/{id}/goals') {
      return Promise.resolve({ data: [GOAL], error: undefined });
    }
    return Promise.resolve({
      data: { data: [], pageInfo: { total: 0, limit: 25, offset: 0, hasNextPage: false } },
      error: undefined,
    });
  });
}

/** `who` is the signed-in principal; the real store, because the identity rules are read from it. */
function renderAs(who: string, permissions: string[], review = REVIEW) {
  held = permissions;
  useAuthStore.setState({
    user: { sub: who, email: 'me@example.com', name: 'Me', roles: [], permissions },
  });
  routeGet(review);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ReviewsTab />
    </QueryClientProvider>,
  );
}

/**
 * Open the review's drawer and wait for its GOALS to arrive.
 *
 * Waiting on a goal ROW rather than on the "Goals" heading matters: the heading renders synchronously
 * and the rows are a second request, so a test that stopped at the heading would assert the absence of
 * an Add-goal button that had simply not rendered yet — passing whatever the gate said.
 */
async function openDrawer(container: HTMLElement) {
  await screen.findByText('Sam Reyes');
  fireEvent.click(container.querySelector('[data-row-id="rev-1"]')!);
  await screen.findByText('Ship the platform migration');
}

describe('ReviewsTab', () => {
  beforeEach(() => vi.clearAllMocks());

  it('gives a performance.read-only bystander the review and nothing to do to it', async () => {
    const { container } = renderAs(ME, ['performance.read']);

    /*
     * The read tier still reads, and this is what it reads for: who reviews whom, and where the review
     * has got to. A gate that hid the list would have removed the tab's purpose for the tier that uses
     * it most, so the positive assertion leads — and it is made BEFORE the drawer opens, because the
     * drawer repeats both names and `getByText` would then find two of each.
     */
    expect(await screen.findByText('Dana Okonkwo')).toBeTruthy();
    expect(screen.getByText('Sam Reyes')).toBeTruthy();

    await openDrawer(container);
    expect(screen.getByText('Ship the platform migration')).toBeTruthy();

    /*
     * THE TWO `performance.manage` ROUTES, WITHHELD. These are the ungated pair this commit closes:
     * reassigning misattributes a judgement somebody else wrote, and cancelling withdraws a review the
     * subject may already be waiting on. Neither belongs to a bystander who merely holds the read code.
     */
    expect(
      screen.queryByRole('button', { name: 'Reassign' }),
      'PATCH reviews/{id}/reviewer requires performance.manage',
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Cancel' }),
      'POST reviews/{id}/cancel requires performance.manage',
    ).toBeNull();

    /*
     * AND NOTHING FROM THE IDENTITY GROUPS EITHER, because this caller is neither the subject nor the
     * reviewer. Worth asserting separately: those are enforced on `user.sub` and not on a permission, so
     * a change that swapped an identity check for a permission check would leave them on screen here.
     */
    expect(screen.queryByRole('button', { name: 'Rate' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Self-assess' })).toBeNull();
    // Goals are reviewer-or-manage, and this caller is neither.
    expect(screen.queryByRole('button', { name: 'Add goal' })).toBeNull();
    expect(screen.queryByRole('button', { name: `Remove ${GOAL.title}` })).toBeNull();
  });

  it('offers reassign and cancel to a performance.manage holder', async () => {
    const { container } = renderAs(ME, ['performance.read', 'performance.manage']);
    await openDrawer(container);

    /*
     * The positive half of the pair above. Without it, deleting the two header actions outright would
     * satisfy the previous case, which is the difference between a gate and a regression.
     */
    expect(screen.getByRole('button', { name: 'Reassign' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();

    /*
     * AND THE GOALS PANEL OPENS FOR THEM, which is a WIDENING and not part of the same fix. `canEdit`
     * read `isReviewer && status === 'manager_review'`, but `mustWriteReview` accepts the reviewer OR
     * `performance.manage` — the controller's own words: HR sets a cycle's goals up and the reviewer
     * refines them, "so both routes exist for both people". So HR was locked out of the setup step its
     * own routes were written for. Invisible from the browser suite because its admin seats are
     * reviewers on the seeded data and satisfied the narrow rule anyway.
     */
    expect(screen.getByRole('button', { name: 'Add goal' })).toBeTruthy();
    expect(screen.getByRole('button', { name: `Remove ${GOAL.title}` })).toBeTruthy();

    // Still not theirs to rate: that one IS reviewer-only, and widening the goals rule must not have
    // widened it too.
    expect(screen.queryByRole('button', { name: 'Rate' })).toBeNull();
  });

  it('lets the SUBJECT self-assess holding no permission whatsoever', async () => {
    /*
     * A SELF-SCOPED ACTION MUST SURVIVE THE GATING. `ROLE.EMPLOYEE` holds no permission codes at all,
     * deliberately, and the route refuses everybody but the subject — so "hide it unless you hold
     * something" would have hidden it from the only person who can use it. This is the assertion that
     * fails if somebody wraps the row actions in `canManage` on the way past.
     */
    const { container } = renderAs(SUBJECT, [], { ...REVIEW, status: 'self_assessment' });
    await screen.findByText('Dana Okonkwo');

    expect(screen.getByRole('button', { name: 'Self-assess' })).toBeTruthy();
    // And still nothing that is not theirs: holding nothing is not holding `performance.manage`.
    fireEvent.click(container.querySelector('[data-row-id="rev-1"]')!);
    await screen.findByText('Goals');
    expect(screen.queryByRole('button', { name: 'Reassign' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('lets the SUBJECT acknowledge a shared review holding nothing', async () => {
    /*
     * The other subject-only route, at the other end of the lifecycle. Asserted separately from
     * self-assessment because they are two routes on two statuses — an acknowledgement recorded by
     * anybody else is evidence of nothing, so this is the last step in the chain and it belongs to the
     * person being judged.
     */
    renderAs(SUBJECT, [], { ...REVIEW, status: 'shared', overallRating: 'meets' });
    await screen.findByText('Dana Okonkwo');

    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeTruthy();
  });

  it('lets the ASSIGNED REVIEWER rate and submit holding no permission', async () => {
    /*
     * SCOPE, NOT PERMISSION. Being named on the row is the authorization here — a manager writes the
     * review they were given and needs no code for it, which is why the reviewer column renders "You".
     * A `canManage` wrapper over the row actions would have taken the reviewer's own queue away from
     * them, and every seat in the browser suite would still have passed because admins hold the code.
     */
    renderAs(REVIEWER, [], { ...REVIEW, overallRating: 'meets' });
    await screen.findByText('Dana Okonkwo');

    expect(screen.getByRole('button', { name: 'Rate' })).toBeTruthy();
    // Offered only once a rating exists — submitting an unrated review is a refusal.
    expect(screen.getByRole('button', { name: 'Send for approval' })).toBeTruthy();
    // The reviewer column says "You", which is how this row is legible as theirs.
    expect(screen.getByText('You')).toBeTruthy();
  });

  it('closes the goals panel once the review has left the reviewer, even for a manage holder', async () => {
    /*
     * PERMISSION AND STATE, STILL SEPARATE. Once a review is with an approver the goal set is what was
     * judged, and that is true of HR and of the reviewer alike — so widening `canEdit` to admit
     * `performance.manage` must not have dropped the status half of the conjunction. Drop it and a
     * manage holder can add a goal to a review already out for sign-off, changing what a rating was
     * measured against after the fact.
     */
    const { container } = renderAs(ME, ['performance.read', 'performance.manage'], {
      ...REVIEW,
      status: 'pending_approval',
      overallRating: 'meets',
      ratedAt: '2026-07-18T09:00:00.000Z',
    });
    await openDrawer(container);

    expect(screen.getByText('Ship the platform migration')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add goal' })).toBeNull();
    expect(screen.queryByRole('button', { name: `Remove ${GOAL.title}` })).toBeNull();
  });
});
