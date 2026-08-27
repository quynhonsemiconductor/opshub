// @vitest-environment jsdom
/**
 * The security-posture dashboard, on the SYNCING side.
 *
 * WHY A COMPONENT TEST AND NOT A BROWSER ONE. The screen renders only when `VITE_FEATURE_SECURITY_POSTURE`
 * is on, and the flag is a build-time constant — a Playwright run has it for every spec or for none, so
 * the browser suite covers the upgrade gate (the shipped default) and this covers the dashboard behind
 * the flag. `@/shared/config/features` is mocked for exactly that reason.
 *
 * WHAT IS WORTH ASSERTING. The three reads are `@RequirePermission('security.view')` and `POST sync` is
 * `@RequirePermission('security.manage')`, while the nav admits the page on `security.view`. So the one
 * button on an otherwise read-only dashboard was offered to a tier the API refuses. Both directions are
 * asserted, and so is the copy beside it: "run a sync to populate" is an instruction, and pointing a
 * reader at a control that is not on their screen is how a gated page starts looking broken instead of
 * read-only.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const GET = vi.fn();
const POST = vi.fn();
/** Swapped per test: the set of permission codes the rendered user holds. */
let granted = new Set<string>();

vi.mock('@/shared/api/client', () => ({
  api: { GET: (...a: unknown[]) => GET(...a), POST: (...a: unknown[]) => POST(...a) },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/shared/config/features', () => ({ FEATURES: { SECURITY_POSTURE: true } }));
vi.mock('@/shared/hooks/use-permissions', () => ({
  // Mirrors the real hook, wildcard included, so a page that read `permissions` directly instead of
  // calling `can()` would fail the wildcard case below rather than pass it by accident.
  usePermissions: () => ({ can: (p: string) => granted.has('*') || granted.has(p) }),
}));

import { SecurityPosturePage } from './security-posture-page';

const LATEST = {
  scoreDate: '2026-08-20',
  score: '412',
  maxScore: '600',
  percentageScore: '68.7',
};

/** `latest: null` is the "nothing synced yet" branch — the one whose copy names the sync. */
function stubReads(latest: unknown) {
  GET.mockImplementation((path: string) => {
    if (path === '/v1/security-posture/score') return Promise.resolve({ data: { latest } });
    if (path === '/v1/security-posture/score/history')
      return Promise.resolve({ data: { history: latest ? [LATEST] : [] } });
    return Promise.resolve({ data: { summary: {}, checks: [] } });
  });
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SecurityPosturePage />
    </QueryClientProvider>,
  );
}

describe('SecurityPosturePage sync gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubReads(LATEST);
    POST.mockResolvedValue({ error: undefined });
  });

  it('offers Sync now to a security.manage holder, and it posts', async () => {
    granted = new Set(['security.view', 'security.manage']);
    renderPage();

    const sync = await screen.findByRole('button', { name: /Sync now/ });
    fireEvent.click(sync);
    // Asserting the POST as well as the button: a gate over a button wired to nothing would pass a
    // presence-only check.
    await waitFor(() => expect(POST).toHaveBeenCalledTimes(1));
    expect(POST.mock.calls[0][0]).toBe('/v1/security-posture/sync');
  });

  it('withholds Sync now from a security.view holder', async () => {
    granted = new Set(['security.view']);
    renderPage();

    // The score read is `security.view`; the sync route is not. The page arrives on the read code.
    expect(await screen.findByText('Secure Score')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Sync now/ })).toBeNull();
  });

  it('still shows the score and the trend to a security.view holder', async () => {
    granted = new Set(['security.view']);
    renderPage();

    // Withholding the only action must not withhold the dashboard — otherwise the screen reads as
    // broken rather than as read-only, and this is the page's whole reason to exist.
    expect(await screen.findByText('69%')).toBeTruthy();
    expect(screen.getByText('30-Day Trend')).toBeTruthy();
  });

  it('tells a security.manage holder to run a sync when nothing is synced', async () => {
    granted = new Set(['security.view', 'security.manage']);
    stubReads(null);
    renderPage();

    expect(await screen.findByText('No data yet — run a sync to populate.')).toBeTruthy();
  });

  it('does not tell a security.view holder to run a sync', async () => {
    granted = new Set(['security.view']);
    stubReads(null);
    renderPage();

    // Same empty state, without an instruction pointing at a button this reader does not have.
    expect(await screen.findByText('No data synced yet.')).toBeTruthy();
    expect(screen.queryByText('No data yet — run a sync to populate.')).toBeNull();
    // What a viewer gets instead: who does run one.
    expect(screen.getByText(/An administrator configures the integration/)).toBeTruthy();
  });

  it('grants the sync on the super-admin wildcard', async () => {
    // A super-admin holds `'*'` and NOT the individual codes; `can()` resolves the wildcard.
    granted = new Set(['*']);
    renderPage();
    expect(await screen.findByRole('button', { name: /Sync now/ })).toBeTruthy();
  });
});
