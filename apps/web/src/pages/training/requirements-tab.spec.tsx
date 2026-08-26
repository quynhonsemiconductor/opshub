// @vitest-environment jsdom
/**
 * WHO MAY CHANGE WHAT A POSITION REQUIRES.
 *
 * WHY THIS TIER IS ONLY REACHABLE FROM A COMPONENT TEST. Every Playwright seat is an administrator and
 * therefore holds `training.manage`, so the browser suite renders this tab in exactly one of its two
 * states and can never observe the other. That asymmetry is why two ungated write controls lived here
 * unnoticed.
 *
 * WHAT THE API ACTUALLY SAYS, route by route. `GET /training/positions/{positionId}/requirements` is
 * `@RequirePermission('training.read')`; `POST` on the same path and `DELETE /training/requirements/{id}`
 * are both `@RequirePermission('training.manage')`. A requirement is the INPUT to the competency gap
 * report, so the read-only tier is not a courtesy: an auditor who could delete a requirement could
 * delete the finding computed from it, which is the audit trail destroying itself.
 *
 * THE TAB STARTS EMPTY BY DESIGN, so every case here has to choose a position first. That is asserted
 * rather than worked around — the empty state is what a reader sees before they pick, and it must not
 * read as "this position requires nothing".
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const GET = vi.fn();

vi.mock('@/shared/api/client', () => ({
  api: { GET: (...a: unknown[]) => GET(...a), POST: vi.fn(), DELETE: vi.fn() },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/** Exact-key matching, so a component gating on the wrong permission cannot pass. */
let held: string[] = [];
vi.mock('@/shared/hooks/use-permissions', () => ({
  usePermissions: () => ({ can: (key: string) => held.includes(key) }),
}));

/**
 * The position picker is replaced, and this is the point of the whole file being a component test.
 *
 * `EntityPicker` is a combobox that fetches, debounces and filters; driving it through a real search
 * would make every assertion below depend on typing, timers and a second endpoint. Here it is reduced
 * to a button that selects one position, because WHICH position is chosen is irrelevant to who may
 * change its requirements — the tab merely has to be past its empty state.
 */
const POSITION_ID = '019fff6b-855d-7fac-8f5e-f79f4fec0bc3';
vi.mock('@/shared/ui', async () => {
  const real = await vi.importActual<typeof import('@/shared/ui')>('@/shared/ui');
  return {
    ...real,
    EntityPicker: ({
      ariaLabel,
      onChange,
    }: {
      ariaLabel?: string;
      onChange: (value: string, option?: { label: string }) => void;
    }) => (
      <button type="button" onClick={() => onChange(POSITION_ID, { label: 'Senior Auditor' })}>
        {ariaLabel ?? 'picker'}
      </button>
    ),
  };
});

import { RequirementsTab } from './requirements-tab';

const REQUIREMENT = {
  id: 'req-1',
  positionId: POSITION_ID,
  courseId: 'course-1',
  courseCode: 'ISO-27001-AW',
  courseTitle: 'Information Security Awareness',
  kind: 'mandatory',
  graceDays: 7,
  createdAt: '2026-01-05T09:00:00.000Z',
};

async function renderAs(permissions: string[]) {
  held = permissions;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <RequirementsTab />
    </QueryClientProvider>,
  );
  // Choose a position, because the tab shows no table at all until one is named.
  screen.getByRole('button', { name: 'Position' }).click();
  await screen.findByText('Information Security Awareness');
  return view;
}

describe('RequirementsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    GET.mockResolvedValue({ data: [REQUIREMENT], error: undefined });
  });

  it('shows what a position requires but no way to change it, to a read-only holder', async () => {
    await renderAs(['training.read']);

    /*
     * The rule itself must still be legible. "Which courses does this job demand" is the question an
     * auditor and a people manager come here to answer, and it is served by a `training.read` route —
     * so a gate that hid the table would have removed the tab's entire purpose for its largest
     * audience while appearing to fix a security bug.
     */
    expect(screen.getByText('ISO-27001-AW')).toBeTruthy();
    expect(screen.getByText('Mandatory')).toBeTruthy();
    expect(screen.getByText(/7 days/)).toBeTruthy();

    // Neither of the two `training.manage` routes is offered.
    expect(screen.queryByRole('button', { name: 'Require a course' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: `Remove ${REQUIREMENT.courseTitle}` }),
      'deleting a requirement deletes the gap-report finding computed from it',
    ).toBeNull();
  });

  it('offers both write controls to a training.manage holder', async () => {
    await renderAs(['training.read', 'training.manage']);

    /*
     * The positive case. Without it, deleting both controls outright would satisfy the test above —
     * so this is what distinguishes a gate from a removal.
     */
    expect(screen.getByRole('button', { name: 'Require a course' })).toBeTruthy();
    expect(screen.getByRole('button', { name: `Remove ${REQUIREMENT.courseTitle}` })).toBeTruthy();
  });

  it('keeps "not yet" and "not you" as visibly different refusals', () => {
    /*
     * A MANAGE HOLDER WHO HAS CHOSEN NOTHING still sees the button, DISABLED. The two reasons to
     * withhold this control are not interchangeable and the UI must not conflate them: "name a
     * position first" is resolved by one click and therefore worth showing, whereas "you do not hold
     * training.manage" is resolved by nothing this user can do and is therefore absent entirely.
     *
     * Collapsing the two — hiding the button when no position is chosen, or grey-disabling it for a
     * reader — is the mistake this pins. A greyed control tells a reader to go looking for the
     * precondition that would enable it, and there isn't one.
     */
    held = ['training.read', 'training.manage'];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <RequirementsTab />
      </QueryClientProvider>,
    );

    const button = screen.getByRole('button', { name: 'Require a course' });
    expect(button).toBeTruthy();
    expect((button as HTMLButtonElement).disabled).toBe(true);
    // And the empty state says why there is no table, rather than claiming the position requires nothing.
    expect(screen.getByText('Choose a position to see what it requires.')).toBeTruthy();
  });
});
