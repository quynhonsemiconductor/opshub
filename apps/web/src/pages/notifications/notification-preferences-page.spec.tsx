// @vitest-environment jsdom
/**
 * The settings screen offers a control for every notification, and only for notifications.
 *
 * WHY THIS EXISTS ALONGSIDE `test/notification-preference-contract.spec.ts`. That test reads the
 * catalogue out of this file's SOURCE and compares it to `NOTIFICATION_TEMPLATE_NAMES`, which is the
 * right way to check two lists agree — but it says nothing about what reaches the screen. A correct
 * list rendered through a filter, a slice, or a group that is never mapped would satisfy it completely
 * while showing the user half the toggles. This asserts the DOM.
 *
 * The counted assertion is deliberately `>=` nothing and `===` the catalogue length: a floor would let
 * a regression that drops nine rows pass as long as it left one.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const GET = vi.fn();
const PUT = vi.fn();
const DELETE = vi.fn();

vi.mock('@/shared/api/client', () => ({
  api: {
    GET: (...a: unknown[]) => GET(...a),
    PUT: (...a: unknown[]) => PUT(...a),
    DELETE: (...a: unknown[]) => DELETE(...a),
  },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { NotificationPreferencesPage } from './notification-preferences-page';

/**
 * Every notification the system can render, copied from `notification.templates.ts`.
 *
 * DUPLICATED ON PURPOSE, and this is the one place duplication is right: `apps/web` cannot import from
 * `libs/`, and the whole point is to catch the page and the backend drifting. A test that derived its
 * expectation from the page's own catalogue would pass by construction. The backend suite's contract
 * test is what keeps this copy honest — it fails if the two lists diverge, naming the difference.
 */
const SENDABLE = [
  'access_request.submitted',
  'access_request.approved',
  'asset.assigned',
  'asset.unassigned',
  'employee.offboarded',
  'contract.expiring_soon',
  'contract.expired',
  'review.due',
  'request.sla_breach',
  'request.delegation_created',
  'request.step_ready',
  'request.submitted',
  'request.approved',
  'request.rejected',
];

/** Toggles are `role="switch"`, two per event (in-app and email), plus two for the global row. */
const CHANNELS_PER_EVENT = 2;

function renderPage(preferences: unknown[] = []) {
  GET.mockResolvedValue({ data: preferences, error: undefined });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NotificationPreferencesPage />
    </QueryClientProvider>,
  );
}

describe('NotificationPreferencesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders one in-app and one email switch for every notification that can be sent', async () => {
    renderPage();
    // Awaiting one label proves the query resolved; the rest are synchronous in the same render.
    await screen.findByText('A request needs your decision');

    const switches = screen.getAllByRole('switch');
    // The global mute row adds its own pair, and it is not one of the sendable types.
    expect(switches.length).toBe(SENDABLE.length * CHANNELS_PER_EVENT + CHANNELS_PER_EVENT);
  });

  it('names every sendable notification in a switch label', async () => {
    renderPage();
    await screen.findByText('A request needs your decision');

    // The accessible name is how a screen-reader user tells the rows apart, so it is what is checked
    // rather than the visible text — and it is built from the label, so a missing row cannot hide.
    const names = screen.getAllByRole('switch').map((s) => s.getAttribute('aria-label') ?? '');
    const missing = SENDABLE.filter(
      (type) => !names.some((n) => n.length > 0 && namesFor(type).some((l) => n.includes(l))),
    );
    expect(missing, `no switch is labelled for: ${missing.join(', ')}`).toEqual([]);
  });

  it('does NOT print the internal event key at the user', async () => {
    renderPage();
    await screen.findByText('A request needs your decision');

    // This row used to read `request.step_ready` in a mono font — the internal name, on the one screen
    // whose job is helping somebody decide whether they want the thing.
    for (const type of SENDABLE) {
      expect(screen.queryByText(type), `${type} is rendered as a raw key`).toBeNull();
    }
  });

  it('explains what triggers the events whose label leaves a gap', async () => {
    renderPage();
    // A hint under the label, not a tooltip: this is always relevant, and always-relevant prose
    // belongs on the page rather than behind a hover.
    expect(
      await screen.findByText(/Multi-step approvals only/i),
      'request.step_ready lost its explanation',
    ).toBeTruthy();
    expect(screen.getByText(/Sent ahead of the renewal date/i)).toBeTruthy();
    expect(screen.getByText(/Risk and supplier reviews/i)).toBeTruthy();
  });

  it('groups the events under headings rather than listing forty switches', async () => {
    renderPage();
    await screen.findByText('A request needs your decision');
    for (const heading of ['Approvals', 'Access', 'Assets', 'Contracts and reviews', 'People']) {
      expect(screen.getByText(heading), `missing group: ${heading}`).toBeTruthy();
    }
  });

  it('disables the per-event switches while the global mute is on', async () => {
    // The wildcard is a kill switch, so a per-event toggle underneath it cannot take effect. Leaving
    // them live would let somebody turn something "on" that stays off.
    renderPage([{ type: '*', inApp: false, email: false }]);
    await screen.findByText('A request needs your decision');

    const perEvent = screen
      .getAllByRole('switch')
      .filter((s) => (s.getAttribute('aria-label') ?? '').includes('A contract has expired'));
    expect(perEvent.length).toBe(CHANNELS_PER_EVENT);
    for (const sw of perEvent) expect(sw).toBeDisabled();
  });
});

/**
 * The label fragments that identify a row for a given event type.
 *
 * The page's labels are prose ("Your request was approved"), not the type, so a test cannot derive one
 * from the other. Mapping them here keeps the assertion above about COVERAGE — every sendable type has
 * a row — without asserting the exact wording, which is editorial and may change.
 */
function namesFor(type: string): string[] {
  const map: Record<string, string> = {
    'access_request.submitted': 'An access request needs review',
    'access_request.approved': 'Your access request was approved',
    'asset.assigned': 'An asset was assigned to you',
    'asset.unassigned': 'An asset was taken back',
    'employee.offboarded': 'An employee was offboarded',
    'contract.expiring_soon': 'A contract is expiring soon',
    'contract.expired': 'A contract has expired',
    'review.due': 'A periodic review is due',
    'request.sla_breach': 'A request has breached its SLA',
    'request.delegation_created': 'Someone delegated their approvals to you',
    'request.step_ready': 'A request has reached your step',
    'request.submitted': 'A request needs your decision',
    'request.approved': 'Your request was approved',
    'request.rejected': 'Your request was rejected',
  };
  return [map[type] ?? type];
}
