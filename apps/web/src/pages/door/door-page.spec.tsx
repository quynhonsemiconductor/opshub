// @vitest-environment jsdom
/**
 * The door page, on the GATING side.
 *
 * WHAT ONLY A COMPONENT TEST REACHES. `door.read` admits the page; `door.manage` drives every
 * action on it. A read-only holder (auditor) must see the registers and the enrolment list without
 * a single write affordance — no "Enrol card", no "Register terminal", no row actions — because a
 * button that only ever answers 403 is a defect the screenshot cannot show.
 *
 * THE TOKEN-ONCE COPY IS ASSERTED TOO: the reveal dialog must say the token will never be shown
 * again. That sentence is the contract between this screen and the sha256-only storage.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const GET = vi.fn();
const POST = vi.fn();
let granted = new Set<string>();

vi.mock('@/shared/api/client', () => ({
  api: {
    GET: (...a: unknown[]) => GET(...a),
    POST: (...a: unknown[]) => POST(...a),
    PATCH: vi.fn(),
  },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/shared/hooks/use-permissions', () => ({
  usePermissions: () => ({ can: (p: string) => granted.has('*') || granted.has(p) }),
}));

import { DoorPage } from './door-page';

const TERMINAL = {
  id: '018f0000-0000-7000-8000-000000000001',
  name: 'Main door',
  location: 'Lobby',
  lastSeenAt: null,
  revokedAt: null,
  droppedEvents: 0,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

const CARD = {
  id: '018f0000-0000-7000-8000-000000000002',
  employeeId: '018f0000-0000-7000-8000-000000000003',
  employeeName: 'Jane Doe',
  uid: '04A1B2C3',
  label: null,
  status: 'active',
  validFrom: '2026-01-01T00:00:00.000Z',
  validUntil: null,
  revokedAt: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

function stubReads() {
  GET.mockImplementation((path: string) => {
    if (path === '/v1/door/terminals')
      return Promise.resolve({ data: [TERMINAL], error: undefined });
    if (path === '/v1/door/cards')
      return Promise.resolve({
        data: { data: [CARD], pageInfo: { total: 1, limit: 25, offset: 0 } },
        error: undefined,
      });
    if (path === '/v1/door/unknown-cards') return Promise.resolve({ data: [], error: undefined });
    throw new Error(`unexpected GET ${path}`);
  });
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DoorPage />
    </QueryClientProvider>,
  );
}

describe('DoorPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    granted = new Set(['door.read']);
    stubReads();
  });

  it('shows the registers to a read-only holder, with no write affordances', async () => {
    renderPage();
    expect(await screen.findByText('04A1B2C3')).toBeInTheDocument();
    expect(screen.queryByText('Enrol card')).not.toBeInTheDocument();
    expect(screen.queryByText('Register terminal')).not.toBeInTheDocument();
    // The card row carries no "Mark lost" action.
    expect(screen.queryByText('Mark lost')).not.toBeInTheDocument();
  });

  it('offers the enrolment actions to a door.manage holder', async () => {
    granted = new Set(['door.read', 'door.manage']);
    renderPage();
    expect(await screen.findByText('Enrol card')).toBeInTheDocument();
    expect(screen.getByText('Register terminal')).toBeInTheDocument();
    expect(await screen.findByText('Mark lost')).toBeInTheDocument();
  });

  it('reveals the terminal token once, with the never-again warning', async () => {
    granted = new Set(['door.read', 'door.manage']);
    POST.mockResolvedValue({
      data: {
        terminal: { ...TERMINAL },
        token: '018f0000-0000-7000-8000-000000000001.secret-value',
      },
      error: undefined,
    });
    renderPage();
    fireEvent.click(await screen.findByText('Register terminal'));
    fireEvent.change(await screen.findByPlaceholderText('Main door controller'), {
      target: { value: 'Main door' },
    });
    fireEvent.click(screen.getByText('Register'));

    await waitFor(() => expect(screen.getByText('Token shown once')).toBeInTheDocument());
    expect(screen.getByText(/last time it is ever shown/)).toBeInTheDocument();
    expect(screen.getByText(/secret-value/)).toBeInTheDocument();
  });

  it('shows an implausible battery warning beside the last good reading', async () => {
    // The server ignores an out-of-window reading and keeps the badge; the Terminals tab must say
    // why, with the value, so a miswired divider is visible instead of silent.
    GET.mockImplementation((path: string) => {
      if (path === '/v1/door/terminals')
        return Promise.resolve({
          data: [
            {
              ...TERMINAL,
              battery: { mv: 5400, low: false, reportedAt: '2026-10-31T00:00:00.000Z' },
              warnings: [
                {
                  code: 'battery_reading_implausible',
                  value: 33_924,
                  at: '2026-10-31T00:00:00.000Z',
                },
              ],
            },
          ],
          error: undefined,
        });
      if (path === '/v1/door/cards')
        return Promise.resolve({
          data: { data: [], pageInfo: { total: 0, limit: 25, offset: 0 } },
          error: undefined,
        });
      if (path === '/v1/door/unknown-cards') return Promise.resolve({ data: [], error: undefined });
      throw new Error(`unexpected GET ${path}`);
    });
    renderPage();
    fireEvent.click(await screen.findByText('Terminals (1)'));
    expect(await screen.findByText('5.40 V')).toBeInTheDocument();
    expect(screen.getByText('implausible 33.92 V — ignored')).toBeInTheDocument();
  });

  it('keeps the empty state honest for a read-only holder', async () => {
    GET.mockImplementation((path: string) => {
      if (path === '/v1/door/terminals') return Promise.resolve({ data: [], error: undefined });
      if (path === '/v1/door/cards')
        return Promise.resolve({
          data: { data: [], pageInfo: { total: 0, limit: 25, offset: 0 } },
          error: undefined,
        });
      if (path === '/v1/door/unknown-cards') return Promise.resolve({ data: [], error: undefined });
      throw new Error(`unexpected GET ${path}`);
    });
    renderPage();
    // Says the register is empty, not "enrol your first card" — that would promise an action the
    // reader cannot take.
    expect(await screen.findByText('No cards enrolled yet.')).toBeInTheDocument();
  });
});
