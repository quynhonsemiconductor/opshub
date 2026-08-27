// @vitest-environment jsdom
/**
 * THE SHIFTS TAB HAS NO DECISION TO OFFER, and that is the thing worth pinning.
 *
 * The other three workforce tabs each carried an ungated Approve/Reject pair; this one was audited for the
 * same fault and has none — the API exposes only `GET /shifts` and `POST /shifts`, there is no
 * `shifts/:id/review`, no `ShiftTypeDef` in the request registry, and no `status` column on the row. A
 * night shift is a RECORD of work done, not a request for permission.
 *
 * So there is nothing here to gate, and this file exists to keep it that way. Two claims:
 *   - nobody, not even the wildcard holder, is offered a decision on a shift log. If a review control ever
 *     appears it must arrive with a permission gate and a test, not inherited from a copied tab.
 *   - logging a shift stays open to a caller holding NOTHING, because `POST /shifts` is `@SelfScoped` —
 *     `employeeId` is the actor and no permission is consulted. This is the assertion that would catch an
 *     over-broad fix that gated the whole tab while gating its buttons.
 *
 * The tab deliberately calls neither `usePermissions` nor `useCurrentUser`, so neither is stubbed: a mock
 * would imply a gate that does not and should not exist.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const GET = vi.fn();
const POST = vi.fn();

vi.mock('@/shared/api/client', () => ({
  api: { GET: (...a: unknown[]) => GET(...a), POST: (...a: unknown[]) => POST(...a) },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/shared/ui/activity-timeline', () => ({ ActivityTimeline: () => null }));

import { ShiftsTab } from './shifts-tab';

const SHIFT = {
  id: 'shift-1',
  employeeId: 'emp-colleague',
  shiftType: 'night',
  startsAt: '2026-03-02T22:00:00.000Z',
  endsAt: '2026-03-03T06:00:00.000Z',
  note: 'Datacentre cutover',
  createdAt: '2026-03-03T07:00:00.000Z',
};

function renderTab() {
  GET.mockResolvedValue({
    data: { data: [SHIFT], pageInfo: { total: 1, limit: 20, offset: 0, hasNextPage: false } },
    error: undefined,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ShiftsTab />
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());

describe('the Shifts tab', () => {
  it('offers no decision on a shift log, because the API has none to make', async () => {
    renderTab();
    await screen.findByText('Datacentre cutover');

    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('lets a caller holding nothing log a shift, which is self-scoped', async () => {
    renderTab();
    await screen.findByText('Datacentre cutover');

    expect(screen.getByRole('button', { name: /log shift/i })).toBeTruthy();
  });
});
