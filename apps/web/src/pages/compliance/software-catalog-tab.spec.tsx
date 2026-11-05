// @vitest-environment jsdom
/**
 * The software catalogue, on the deciding side.
 *
 * WHAT ONLY A COMPONENT TEST REACHES:
 *   - THE TWO FILTERS ARE ACTUALLY SENT. `listing` and `search` are parameters `/v1/compliance/software`
 *     has always taken and this tab never passed. A filter that renders and filters nothing looks identical
 *     in a screenshot — it is the same fault the roles picker had, where the term was dropped.
 *   - AN EMPTIED NOTE SENDS `null`, not `''`. The column is nullable and "no reason recorded" is a real
 *     state; an empty string would store a blank the next reader cannot tell from a missing one.
 *   - RECLASSIFY IS WITHHELD WITHOUT `compliance.manage`, since the route is guarded by it.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const GET = vi.fn();
const PATCH = vi.fn();
let canAll = true;

vi.mock('@/shared/api/client', () => ({
  api: { GET: (...a: unknown[]) => GET(...a), PATCH: (...a: unknown[]) => PATCH(...a) },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/shared/hooks/use-permissions', () => ({
  usePermissions: () => ({ can: () => canAll }),
}));

import { SoftwareCatalogTab } from './software-catalog-tab';

const ENTRY = {
  id: 'sw-1',
  name: 'Unapproved Torrent Client',
  publisher: 'Nobody Ltd',
  listing: 'review',
  notes: 'Flagged by the Intune scan.',
  createdAt: '2026-08-01T09:00:00.000Z',
  updatedAt: '2026-08-01T09:00:00.000Z',
};

function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SoftwareCatalogTab />
    </QueryClientProvider>,
  );
}

/** The `query` object of the most recent list call. */
function lastQuery(): Record<string, unknown> {
  const call = GET.mock.calls.at(-1);
  return (call?.[1] as { params: { query: Record<string, unknown> } }).params.query;
}

describe('SoftwareCatalogTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canAll = true;
    GET.mockResolvedValue({ data: { data: [ENTRY], pageInfo: { total: 1 } }, error: undefined });
    PATCH.mockResolvedValue({ error: undefined });
  });

  it('sends the listing filter the API has always taken', async () => {
    renderTab();
    expect(await screen.findByText('Unapproved Torrent Client')).toBeTruthy();
    // Nothing selected: the parameter is absent rather than an empty string, which the API would reject
    // as an invalid enum value.
    expect(lastQuery().listing).toBeUndefined();

    fireEvent.click(screen.getByRole('radio', { name: 'Blacklisted' }));
    await waitFor(() => expect(lastQuery().listing).toBe('blacklisted'));
  });

  it('sends the search term', async () => {
    renderTab();
    expect(await screen.findByText('Unapproved Torrent Client')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Search software'), { target: { value: 'torrent' } });
    await waitFor(() => expect(lastQuery().search).toBe('torrent'));
  });

  it('patches the listing and sends an emptied note as null', async () => {
    renderTab();
    expect(await screen.findByText('Unapproved Torrent Client')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Reclassify' }));
    // Pre-filled from the row, so a listing change cannot silently blank a reason somebody wrote.
    const notes = screen.getByLabelText(/^Why/);
    expect((notes as HTMLTextAreaElement).value).toBe('Flagged by the Intune scan.');

    fireEvent.change(screen.getByLabelText(/^Listing/), { target: { value: 'blacklisted' } });
    fireEvent.change(notes, { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save listing' }));

    await waitFor(() => expect(PATCH).toHaveBeenCalledTimes(1));
    expect(PATCH.mock.calls[0][0]).toBe('/v1/compliance/software/{id}');
    expect(PATCH.mock.calls[0][1]).toEqual({
      params: { path: { id: 'sw-1' } },
      // `null`, not `''` — the column is nullable and a blank string is a different claim.
      body: { listing: 'blacklisted', notes: null },
    });
  });

  it('offers no reclassify without compliance.manage', async () => {
    canAll = false;
    renderTab();
    expect(await screen.findByText('Unapproved Torrent Client')).toBeTruthy();

    // The route is guarded by `compliance.manage`; reading the catalogue needs only `compliance.read`.
    expect(screen.queryByRole('button', { name: 'Reclassify' })).toBeNull();
  });
});
