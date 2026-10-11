// @vitest-environment jsdom
/**
 * The Shadow IT panel.
 *
 * WHY A COMPONENT TEST AND NOT A BROWSER ONE. The panel renders only when `VITE_FEATURE_SHADOW_IT` is on, and
 * the flag is a build-time constant — a Playwright run either has it for every spec or for none, so the
 * browser suite covers the upgrade gate (the shipped default) and this covers the panel behind the flag.
 *
 * WHAT IS WORTH ASSERTING. The scan does not run in the request — the API queues it (202) and the worker runs it:
 *   - `queued: true` is a new scan; the screen must not claim results it does not have.
 *   - `queued: false` means one was already waiting, which is a different answer from "nothing happened".
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const GET = vi.fn();
const POST = vi.fn();
const toastSuccess = vi.fn();

vi.mock('@/shared/api/client', () => ({
  api: { GET: (...a: unknown[]) => GET(...a), POST: (...a: unknown[]) => POST(...a) },
}));
vi.mock('sonner', () => ({ toast: { success: (m: string) => toastSuccess(m), error: vi.fn() } }));
vi.mock('@/shared/hooks/use-permissions', () => ({
  usePermissions: () => ({ can: () => true }),
}));

import { ShadowItPanel } from './shadow-it-tab';

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ShadowItPanel />
    </QueryClientProvider>,
  );
}

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

describe('ShadowItPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    GET.mockResolvedValue({ data: { findings: [FINDING], total: 1 }, error: undefined });
  });

  it('lists a detection with the software, its severity and where it was found', async () => {
    renderPanel();

    expect(await screen.findByText('Unapproved Torrent Client')).toBeTruthy();
    expect(screen.getByText(/version 3\.2\.1/)).toBeTruthy();
    expect(screen.getByText('High')).toBeTruthy();
    // The device is what makes a detection actionable: the same app is a different problem elsewhere.
    expect(screen.getByText('asset-1')).toBeTruthy();
  });

  it('says a scan was queued, without claiming results', async () => {
    POST.mockResolvedValue({ data: { queued: true }, error: undefined });
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: /run a scan/i }));

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        'Scan queued — new findings appear here when it finishes',
      ),
    );
  });

  it('says so when a scan was already waiting', async () => {
    POST.mockResolvedValue({ data: { queued: false }, error: undefined });
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: /run a scan/i }));

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        'A scan is already queued — new findings appear here when it finishes',
      ),
    );
  });

  it('renders an empty state rather than an error when nothing is detected', async () => {
    GET.mockResolvedValue({ data: { findings: [], total: 0 }, error: undefined });
    renderPanel();

    expect(await screen.findByText(/No unapproved software detected/i)).toBeTruthy();
  });
});
