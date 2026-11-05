// @vitest-environment jsdom
/**
 * The Ranks screen — who may change a rank, and what saving one sends.
 *
 * A rank's weekly work-from-home allowance decides whether an employee can file WFH at all, so the write
 * controls are gated on the permission the API enforces (`role.manage`), and a reader who only holds
 * `role.read` must not be offered any. The save flow is asserted because it is two calls (the rank, then the
 * benefit set) and the second REPLACES the whole set: sending only the allowance would silently drop any
 * other benefit the rank carries.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const caller = vi.hoisted(() => ({ permissions: [] as string[] }));

const GET = vi.fn();
const POST = vi.fn();
const PATCH = vi.fn();
const PUT = vi.fn();
const DELETE = vi.fn();

vi.mock('@/shared/api/client', () => ({
  api: {
    GET: (...a: unknown[]) => GET(...a),
    POST: (...a: unknown[]) => POST(...a),
    PATCH: (...a: unknown[]) => PATCH(...a),
    PUT: (...a: unknown[]) => PUT(...a),
    DELETE: (...a: unknown[]) => DELETE(...a),
  },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/shared/hooks/use-permissions', () => ({
  usePermissions: () => ({ can: (perm: string) => caller.permissions.includes(perm) }),
}));

import { RanksPage } from './ranks-page';

const _JUNIOR = {
  id: 'rank-1',
  ordinal: 1,
  name: 'Junior',
  benefits: [{ benefitCode: 'wfh_weekly_days', value: 1 }],
  createdAt: '2026-11-01T09:00:00.000Z',
  updatedAt: '2026-11-01T09:00:00.000Z',
};
const _SENIOR = { ..._JUNIOR, id: 'rank-2', ordinal: 3, name: 'Senior', benefits: [] };

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RanksPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  caller.permissions = [];
  GET.mockResolvedValue({ data: [_JUNIOR, _SENIOR] });
});

describe('the Ranks screen, for a role.read holder', () => {
  beforeEach(() => {
    caller.permissions = ['role.read'];
  });

  it('lists each rank with its weekly work-from-home days, or None', async () => {
    renderPage();

    expect(await screen.findByText('Junior')).toBeTruthy();
    expect(screen.getByText('Senior')).toBeTruthy();
    expect(screen.getByText('None')).toBeTruthy();
  });

  it('offers no write control, because every write route needs role.manage', async () => {
    renderPage();
    await screen.findByText('Junior');

    expect(screen.queryByRole('button', { name: /new rank/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit Junior' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete Junior' })).toBeNull();
  });
});

describe('the Ranks screen, for a role.manage holder', () => {
  beforeEach(() => {
    caller.permissions = ['role.read', 'role.manage'];
  });

  it('creates a rank and then sets its weekly allowance', async () => {
    POST.mockResolvedValue({ data: { ..._JUNIOR, id: 'rank-9', ordinal: 4, name: 'Lead' } });
    PUT.mockResolvedValue({ data: {} });
    renderPage();
    await screen.findByText('Junior');

    fireEvent.click(screen.getByRole('button', { name: /new rank/i }));
    const dialog = within(screen.getByRole('dialog'));
    fireEvent.change(dialog.getByLabelText(/^Order/), { target: { value: '4' } });
    fireEvent.change(dialog.getByLabelText(/^Name/), { target: { value: 'Lead' } });
    fireEvent.change(dialog.getByLabelText(/Work-from-home days/), { target: { value: '3' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Create rank' }));

    await waitFor(() => expect(PUT).toHaveBeenCalledTimes(1));
    expect(POST).toHaveBeenCalledWith('/v1/job-ranks', { body: { ordinal: 4, name: 'Lead' } });
    expect(PUT).toHaveBeenCalledWith('/v1/job-ranks/{id}/benefits', {
      params: { path: { id: 'rank-9' } },
      body: { benefits: [{ benefitCode: 'wfh_weekly_days', value: 3 }] },
    });
  });

  it('changes only the allowance of an existing rank, without renaming it', async () => {
    PUT.mockResolvedValue({ data: {} });
    renderPage();
    await screen.findByText('Junior');

    fireEvent.click(screen.getByRole('button', { name: 'Edit Junior' }));
    const dialog = within(screen.getByRole('dialog'));
    fireEvent.change(dialog.getByLabelText(/Work-from-home days/), { target: { value: '2' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(PUT).toHaveBeenCalledTimes(1));
    expect(PATCH).not.toHaveBeenCalled();
    expect(PUT).toHaveBeenCalledWith('/v1/job-ranks/{id}/benefits', {
      params: { path: { id: 'rank-1' } },
      body: { benefits: [{ benefitCode: 'wfh_weekly_days', value: 2 }] },
    });
  });

  it('refuses an allowance larger than a week before calling the API', async () => {
    renderPage();
    await screen.findByText('Junior');

    fireEvent.click(screen.getByRole('button', { name: 'Edit Junior' }));
    const dialog = within(screen.getByRole('dialog'));
    fireEvent.change(dialog.getByLabelText(/Work-from-home days/), { target: { value: '9' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Save changes' }));

    expect(await dialog.findByText(/at most 7 days/)).toBeTruthy();
    expect(PUT).not.toHaveBeenCalled();
  });

  it('shows the API’s own sentence when a rank cannot be deleted', async () => {
    DELETE.mockResolvedValue({
      error: {
        error: {
          code: 'JOB_RANK_IN_USE',
          message: "Rank 'Junior' is carried by 2 role(s); move them first",
        },
      },
    });
    const { toast } = await import('sonner');
    renderPage();
    await screen.findByText('Junior');

    fireEvent.click(screen.getByRole('button', { name: 'Delete Junior' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete rank' }),
    );

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('carried by 2 role(s)')),
    );
  });
});
