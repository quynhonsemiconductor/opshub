// @vitest-environment jsdom
/**
 * The door modals, on the PRESET side.
 *
 * WHAT ONLY A COMPONENT TEST REACHES. `AssignUnknownCardModal` is ALWAYS MOUNTED on the page — it
 * opens and closes with an event. Its first draft captured `presetUid` into `useState` ONCE, so
 * clicking row A then row B enrolled B's UID into a form still showing… actually no: showing A's
 * forever. The fix is KEYING the modal on the event so each row remounts the form; this spec pins
 * that a different event yields a different pre-filled UID.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const GET = vi.fn();

vi.mock('@/shared/api/client', () => ({
  api: { GET: (...a: unknown[]) => GET(...a), POST: vi.fn(), PATCH: vi.fn() },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AssignUnknownCardModal } from './door-modals';

const EVENT = (uid: string) => ({
  uid,
  reader: 'in' as const,
  count: 2,
  lastSeenAt: '2026-10-23T08:00:00.000Z',
});

function renderModal(event: ReturnType<typeof EVENT> | null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AssignUnknownCardModal event={event} onClose={() => undefined} />
    </QueryClientProvider>,
  );
}

describe('AssignUnknownCardModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The EntityPicker's opening fetch; nobody picks anybody in this spec.
    GET.mockImplementation((path: string) =>
      Promise.resolve(
        path === '/v1/employees'
          ? { data: { data: [], pageInfo: { total: 0, limit: 25, offset: 0 } }, error: undefined }
          : { data: undefined, error: undefined },
      ),
    );
  });

  it('pre-fills the UID from the unknown-card row', () => {
    renderModal(EVENT('04A1B2C3'));
    expect(screen.getByDisplayValue('04A1B2C3')).toBeInTheDocument();
  });

  it("shows the NEXT row's UID when the caller switches events — the keyed remount, not stale state", () => {
    const { rerender } = renderModal(EVENT('04A1B2C3'));
    expect(screen.getByDisplayValue('04A1B2C3')).toBeInTheDocument();

    rerender(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <AssignUnknownCardModal event={EVENT('04B2C3D4')} onClose={() => undefined} />
      </QueryClientProvider>,
    );
    expect(screen.getByDisplayValue('04B2C3D4')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('04A1B2C3')).not.toBeInTheDocument();
  });

  it('leaves the UID editable when opened without a row', () => {
    // The toolbar path renders AddCardModal with no preset: open, but keyed off any row.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <AssignUnknownCardModal event={EVENT('04A1B2C3')} onClose={() => undefined} />
      </QueryClientProvider>,
    );
    fireEvent.change(screen.getByDisplayValue('04A1B2C3'), { target: { value: '04FFFFFF' } });
    expect(screen.getByDisplayValue('04FFFFFF')).toBeInTheDocument();
  });
});
