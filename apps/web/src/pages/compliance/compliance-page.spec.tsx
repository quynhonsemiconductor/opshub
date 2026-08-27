// @vitest-environment jsdom
/**
 * The findings tab, on the deciding side.
 *
 * WHAT ONLY A COMPONENT TEST REACHES. Acknowledge and Resolve were gated on the finding's STATUS alone,
 * while both routes carry `@RequirePermission('compliance.manage')`
 * (`libs/modules/compliance/src/interface/http/compliance.controller.ts`). So every holder of
 * `compliance.read` — `auditor` holds exactly that and no compliance write code — saw both actions on
 * every finding in the tenant, and every click was a permanent 403 rendered as "please try again". An
 * API test cannot see it: the server was always right, and the SPA was offering a door it had locked.
 *
 * BOTH DIRECTIONS ARE ASSERTED. A gate is two claims — the holder still gets the action, and the
 * reader does not — and a test of only the second passes just as well when the action is deleted.
 *
 * BOTH SURFACES ARE ASSERTED. The table row and the detail slide-over the row opens offer the same two
 * writes, and gating only the row would leave the 403 exactly one click further away.
 *
 * `can` HERE IS PERMISSION-AWARE, not a constant `true`/`false`. A mock that ignores its argument
 * cannot tell `can('compliance.manage')` from `can('compliance.read')`, so swapping the code for
 * another real one would keep every assertion green — which is the mutation this file exists to kill.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const GET = vi.fn();
const POST = vi.fn();
const PATCH = vi.fn();
/** The reader's effective permission keys, as `/me` would return them. */
let granted: string[] = ['compliance.read', 'compliance.manage'];

vi.mock('@/shared/api/client', () => ({
  api: {
    GET: (...a: unknown[]) => GET(...a),
    POST: (...a: unknown[]) => POST(...a),
    PATCH: (...a: unknown[]) => PATCH(...a),
  },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/shared/hooks/use-permissions', () => ({
  usePermissions: () => ({ can: (perm: string) => granted.includes(perm) }),
}));

import { CompliancePage } from './compliance-page';

const FINDING = {
  id: 'f-1',
  assetId: 'asset-1',
  employeeId: null,
  softwareName: 'Unapproved Torrent Client',
  softwareVersion: '3.2.1',
  severity: 'high',
  status: 'open',
  source: 'shadow-it:intune',
  detectedAt: '2026-08-01T09:00:00.000Z',
  resolvedBy: null,
  resolutionNote: null,
  resolvedAt: null,
};

const EMPTY = { data: { data: [], pageInfo: { total: 0 } }, error: undefined };

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CompliancePage />
    </QueryClientProvider>,
  );
}

/** The page opens on the software catalogue; the findings live one tab across. */
async function openFindings() {
  renderPage();
  fireEvent.click(screen.getByRole('tab', { name: 'Findings' }));
  // Asserted before anything else in every test: an absent action and an absent TABLE look identical,
  // so the read-only cases would pass on a page that failed to load.
  expect(await screen.findByText('Unapproved Torrent Client')).toBeTruthy();
}

/** Opens the detail slide-over by clicking the row, and returns the dialog to scope queries to. */
async function openDetail(): Promise<HTMLElement> {
  fireEvent.click(screen.getByText('Unapproved Torrent Client'));
  return await screen.findByRole('dialog');
}

describe('CompliancePage findings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    granted = ['compliance.read', 'compliance.manage'];
    GET.mockImplementation((path: string) => {
      if (path === '/v1/compliance/findings') {
        return Promise.resolve({
          data: { data: [FINDING], pageInfo: { total: 1 } },
          error: undefined,
        });
      }
      return Promise.resolve(EMPTY);
    });
    POST.mockResolvedValue({ data: FINDING, error: undefined });
  });

  it('offers Acknowledge and Resolve in the row to a compliance.manage holder', async () => {
    await openFindings();

    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Resolve' })).toBeTruthy();
  });

  it('acknowledges through the route the permission guards', async () => {
    await openFindings();

    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));

    await waitFor(() => expect(POST).toHaveBeenCalledTimes(1));
    // Named in full, because it is the `compliance.manage` route the gate above is derived from.
    expect(POST.mock.calls[0][0]).toBe('/v1/compliance/findings/{id}/acknowledge');
    expect(POST.mock.calls[0][1]).toEqual({ params: { path: { id: 'f-1' } } });
  });

  it('offers Acknowledge and Resolve in the detail panel to a compliance.manage holder', async () => {
    await openFindings();
    const dialog = await openDetail();

    expect(within(dialog).getByRole('button', { name: 'Acknowledge' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Resolve' })).toBeTruthy();
  });

  it('withholds both row actions from a compliance.read holder', async () => {
    granted = ['compliance.read'];
    await openFindings();

    // Both routes are guarded by `compliance.manage`; reading findings needs only `compliance.read`.
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resolve' })).toBeNull();
  });

  it('withholds both panel actions from a compliance.read holder', async () => {
    granted = ['compliance.read'];
    await openFindings();
    const dialog = await openDetail();

    // The panel opened — it is the actions that are absent, not the panel.
    expect(within(dialog).getByRole('heading', { name: 'Unapproved Torrent Client' })).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Acknowledge' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Resolve' })).toBeNull();
  });

  it('withholds Resolve from an acknowledged finding for a compliance.read holder', async () => {
    // The status branches and the permission branch are independent, and a gate applied to only ONE of
    // the two buttons passes a test that looks at an open finding alone. An acknowledged finding offers
    // Resolve and not Acknowledge, so this sees the Resolve gate on its own.
    granted = ['compliance.read'];
    GET.mockImplementation((path: string) => {
      if (path === '/v1/compliance/findings') {
        return Promise.resolve({
          data: { data: [{ ...FINDING, status: 'acknowledged' }], pageInfo: { total: 1 } },
          error: undefined,
        });
      }
      return Promise.resolve(EMPTY);
    });
    await openFindings();

    expect(screen.queryByRole('button', { name: 'Resolve' })).toBeNull();
  });

  it('leaves the actions cell genuinely empty when no action applies', async () => {
    // A resolved finding has neither action even for a manager, and an empty `RowActions` is a flex row
    // wrapping nothing — a container in the accessibility tree that holds no control. Asserted on the
    // cell's child count rather than on its classes, which is the shape and not the styling.
    GET.mockImplementation((path: string) => {
      if (path === '/v1/compliance/findings') {
        return Promise.resolve({
          data: {
            data: [{ ...FINDING, status: 'resolved', resolvedAt: '2026-08-02T09:00:00.000Z' }],
            pageInfo: { total: 1 },
          },
          error: undefined,
        });
      }
      return Promise.resolve(EMPTY);
    });
    await openFindings();

    const cells = within(screen.getByText('Unapproved Torrent Client').closest('tr')!).getAllByRole(
      'cell',
    );
    expect(cells.at(-1)!.childElementCount).toBe(0);
  });

  it('still offers Resolve on an acknowledged finding to a compliance.manage holder', async () => {
    GET.mockImplementation((path: string) => {
      if (path === '/v1/compliance/findings') {
        return Promise.resolve({
          data: { data: [{ ...FINDING, status: 'acknowledged' }], pageInfo: { total: 1 } },
          error: undefined,
        });
      }
      return Promise.resolve(EMPTY);
    });
    await openFindings();

    expect(screen.getByRole('button', { name: 'Resolve' })).toBeTruthy();
    // Acknowledging twice is a 412 the API would refuse, so the status branch must survive the gate.
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).toBeNull();
  });
});
