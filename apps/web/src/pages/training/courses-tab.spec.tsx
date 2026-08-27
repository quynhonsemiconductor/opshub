// @vitest-environment jsdom
/**
 * WHO MAY CHANGE THE COURSE CATALOGUE — the read tier and the write tier, asserted apart.
 *
 * WHY A COMPONENT TEST AND NOT A BROWSER ONE. All eight Playwright seats are administrators, so every
 * one of them holds `training.manage` and every one of them sees every button on this tab. A
 * read-only tier is a tier the browser suite structurally cannot represent — which is precisely how
 * three ungated write controls survived here — so the tier has to be constructed, and the only way to
 * construct it is to drive `usePermissions` from the test.
 *
 * THE TIER THAT MATTERS IS REAL, not hypothetical. `ROLE.MANAGER` and `ROLE.AUDITOR` both hold
 * `training.read` and neither holds `training.manage` (`db/permissions.catalog.ts`), and the API is
 * unambiguous about the consequence: `POST /training/courses`, `PATCH /training/courses/{id}` and
 * `POST /training/courses/{id}/retire` each carry `@RequirePermission('training.manage')`, while the
 * list behind them asks only for `training.read`. So the reader below is an auditor, and what these
 * assertions pin is that an auditor is not handed edit rights over the catalogue an audit reads.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const GET = vi.fn();

vi.mock('@/shared/api/client', () => ({
  api: { GET: (...a: unknown[]) => GET(...a), POST: vi.fn(), PATCH: vi.fn() },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/**
 * The permission set under test, swapped per case.
 *
 * A LIST AND NOT A BOOLEAN, deliberately. `can: () => true` would pass whatever key the component
 * asked for, so a component gating on `traning.manage` — or on `capa.manage`, or on nothing at all —
 * would satisfy the manager case exactly as well as the correct one. Matching the exact key is what
 * makes the assertion about the catalogue's spelling and not merely about a boolean being consulted.
 */
let held: string[] = [];
vi.mock('@/shared/hooks/use-permissions', () => ({
  usePermissions: () => ({ can: (key: string) => held.includes(key) }),
}));

import { CoursesTab } from './courses-tab';

const COURSE = {
  id: 'course-1',
  code: 'ISO-27001-AW',
  title: 'Information Security Awareness',
  category: 'compliance',
  provider: 'Internal',
  validityMonths: 12,
  retiredAt: null,
  createdAt: '2026-01-05T09:00:00.000Z',
  updatedAt: '2026-01-05T09:00:00.000Z',
};

function renderAs(permissions: string[]) {
  held = permissions;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CoursesTab />
    </QueryClientProvider>,
  );
}

describe('CoursesTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    GET.mockResolvedValue({
      data: {
        data: [COURSE],
        pageInfo: { total: 1, limit: 25, offset: 0, hasNextPage: false },
      },
      error: undefined,
    });
  });

  it('shows the catalogue but no write control to a training.read-only holder', async () => {
    renderAs(['training.read']);

    /*
     * The row must be THERE. Half of this gate is that a reader still reads: a fix that hid the table
     * along with the buttons would pass every negative assertion below and would have removed the
     * auditor's actual job, so the positive assertion is load-bearing and comes first.
     */
    expect(await screen.findByText('Information Security Awareness')).toBeTruthy();
    expect(screen.getByText('ISO-27001-AW')).toBeTruthy();

    /*
     * And now the three routes that answer 403 for this caller. Queried by the accessible name a user
     * would reach for, not by a test id: the Edit and Retire controls are icon-only, so their
     * `aria-label` IS their name, and asserting on it also pins that they keep having one.
     */
    expect(screen.queryByRole('button', { name: 'New course' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: `Edit ${COURSE.title}` }),
      'the Edit pencil is POST-gated on training.manage and answered 403 for every auditor',
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: `Retire ${COURSE.title}` }),
      'retiring is a state transition behind training.manage, not a view preference',
    ).toBeNull();
  });

  it('offers all three write controls to a training.manage holder', async () => {
    renderAs(['training.read', 'training.manage']);

    expect(await screen.findByText('Information Security Awareness')).toBeTruthy();

    /*
     * The other half, and the reason this is not simply "hide everything". A gate with no positive
     * case is indistinguishable from deleting the feature — and deleting the feature would also pass
     * the read-only test above. Each of these is the one control that reaches its route.
     */
    expect(screen.getByRole('button', { name: 'New course' })).toBeTruthy();
    expect(screen.getByRole('button', { name: `Edit ${COURSE.title}` })).toBeTruthy();
    expect(screen.getByRole('button', { name: `Retire ${COURSE.title}` })).toBeTruthy();
  });

  it('still withholds Retire on an already-retired course from a manage holder', async () => {
    GET.mockResolvedValue({
      data: {
        data: [{ ...COURSE, retiredAt: '2026-03-01T09:00:00.000Z' }],
        pageInfo: { total: 1, limit: 25, offset: 0, hasNextPage: false },
      },
      error: undefined,
    });
    renderAs(['training.read', 'training.manage']);

    expect(await screen.findByText('Retired')).toBeTruthy();
    /*
     * THE PERMISSION AND THE LIFECYCLE ARE DIFFERENT AXES, and this is the assertion that keeps them
     * that way. Retiring is one-way, so a retired course has nothing left for this button to do —
     * a rewrite that folded the status rule into the permission check (or dropped it while adding the
     * permission check) would leave a Retire button on a course that is already retired.
     */
    expect(screen.queryByRole('button', { name: `Retire ${COURSE.title}` })).toBeNull();
    // Edit survives retirement — a retired course's title and provider are still corrigible.
    expect(screen.getByRole('button', { name: `Edit ${COURSE.title}` })).toBeTruthy();
  });
});
