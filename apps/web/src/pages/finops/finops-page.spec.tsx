// @vitest-environment jsdom
/**
 * The licence register, on the WRITING side.
 *
 * WHAT ONLY A COMPONENT TEST REACHES. This screen is admitted by the nav on `license.read`, and every
 * route that changes a licence is `@RequirePermission('license.manage')` — so the two "Add license"
 * buttons were offered to a tier that could only ever be refused by the API. Nothing about that shows
 * up in a screenshot or a type check: the button renders, looks enabled, and fails on click. The only
 * way to hold it is to render the page as each tier and assert what is there.
 *
 * THE EMPTY STATE IS PART OF THE GATE. An empty register told the reader to "add your first license",
 * which for a read-only holder is the same false promise as the button, minus the 403. Both directions
 * of that copy are asserted, because withholding the button while keeping the instruction would leave
 * a screen that reads as broken rather than as read-only.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const GET = vi.fn();
/** Swapped per test: the set of permission codes the rendered user holds. */
let granted = new Set<string>();

vi.mock('@/shared/api/client', () => ({
  api: { GET: (...a: unknown[]) => GET(...a), POST: vi.fn(), DELETE: vi.fn() },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/shared/hooks/use-permissions', () => ({
  // Mirrors the real hook, wildcard included, so a page that read `permissions` directly instead of
  // calling `can()` would fail the wildcard case below rather than pass it by accident.
  usePermissions: () => ({ can: (p: string) => granted.has('*') || granted.has(p) }),
}));

import { FinOpsPage } from './finops-page';

const LICENSE = {
  id: 'lic-1',
  name: 'Figma Organization',
  vendor: 'Figma',
  vendorId: null,
  licenseType: 'per_seat',
  seatCount: 40,
  costPerSeatCents: 4500,
  renewalDate: '2027-01-31',
  status: 'active',
  notes: null,
  externalId: null,
  createdAt: '2026-08-01T09:00:00.000Z',
  updatedAt: '2026-08-01T09:00:00.000Z',
};

/**
 * The page fires two reads. `utilization` stays empty on purpose: the charts render their own
 * "no cost data" branch, which keeps recharts out of a jsdom layout it has no box for.
 */
function stubReads(rows: unknown[]) {
  GET.mockImplementation((path: string) =>
    Promise.resolve(
      path === '/v1/licenses/utilization'
        ? { data: [], error: undefined }
        : { data: { data: rows, pageInfo: { total: rows.length, limit: 50, offset: 0 } } },
    ),
  );
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <FinOpsPage />
    </QueryClientProvider>,
  );
}

describe('FinOpsPage licence-writing gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubReads([LICENSE]);
  });

  it('offers Add license to a license.manage holder', async () => {
    granted = new Set(['license.read', 'license.manage']);
    renderPage();
    expect(await screen.findByText('Figma Organization')).toBeTruthy();

    // `POST /v1/licenses` is `@RequirePermission('license.manage')`, so this is the tier that may click.
    // Exactly one: the header action. The empty-state one belongs to an empty table.
    const add = screen.getAllByRole('button', { name: /Add license/ });
    expect(add).toHaveLength(1);

    // And it still opens the form. A gate over a button wired to nothing would pass a presence check.
    fireEvent.click(add[0]);
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('withholds Add license from a license.read holder', async () => {
    granted = new Set(['license.read']);
    renderPage();
    expect(await screen.findByText('Figma Organization')).toBeTruthy();

    // The nav admits this page on `license.read`; the write route does not. A rendered button here is
    // a guaranteed 403.
    expect(screen.queryByRole('button', { name: /Add license/ })).toBeNull();
  });

  it('still shows the register to a license.read holder', async () => {
    granted = new Set(['license.read']);
    renderPage();

    // Withholding the action must not withhold the screen: the reader keeps the tiles and the table.
    expect(await screen.findByText('Figma Organization')).toBeTruthy();
    expect(screen.getByText('Licenses tracked')).toBeTruthy();
  });

  it('invites a license.manage holder to add the first licence when empty', async () => {
    granted = new Set(['license.read', 'license.manage']);
    stubReads([]);
    renderPage();

    expect(
      await screen.findByText('Add your first license to start tracking seats and cost'),
    ).toBeTruthy();
    // TWO, not one: the header action and the empty-state action are separate `setShowAdd` call sites,
    // and a count catches gating only one of them — which a presence check would report as a pass.
    expect(screen.getAllByRole('button', { name: /Add license/ })).toHaveLength(2);
  });

  it('does not tell a license.read holder to add the first licence', async () => {
    granted = new Set(['license.read']);
    stubReads([]);
    renderPage();

    expect(await screen.findByText('No licenses tracked yet')).toBeTruthy();
    expect(
      screen.queryByText('Add your first license to start tracking seats and cost'),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: /Add license/ })).toBeNull();
  });

  it('grants both controls on the super-admin wildcard', async () => {
    // A super-admin holds `'*'` and NOT the individual codes; `can()` resolves the wildcard. The page
    // must go through `can()` for that to work.
    granted = new Set(['*']);
    renderPage();
    expect(await screen.findByText('Figma Organization')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Add license/ })).toBeTruthy();
  });
});
