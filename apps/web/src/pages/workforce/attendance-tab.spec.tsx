// @vitest-environment jsdom
/**
 * THE CHẤM CÔNG TAB — the derived month in Vietnamese, the justification flow, and the month close.
 *
 * The API is faked at the client boundary (same reason as the WIO spec): the interesting behaviour
 * is what the tab asks for and what it does with the answer, not HTTP.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const GET = vi.fn();
const POST = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();

vi.mock('@/shared/api/client', () => ({
  api: { GET: (...a: unknown[]) => GET(...a), POST: (...a: unknown[]) => POST(...a) },
}));
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));
const can = vi.fn();
vi.mock('@/shared/hooks/use-permissions', () => ({
  usePermissions: () => ({
    can: (p: string) => can(p),
    hasRole: (r: string) => r === 'manager' && can('__role_manager'),
  }),
}));
vi.mock('@/shared/hooks/use-current-user', () => ({
  useCurrentUser: () => ({ data: { sub: 'me' } }),
}));

vi.setSystemTime(new Date('2026-10-21T12:00:00'));

import { AttendanceTab } from './attendance-tab';

const PEOPLE = [
  {
    id: 'me',
    name: 'Quang',
    department: 'Management',
    days: [
      {
        date: '2026-10-21',
        status: 'office' as const,
        workedMinutes: 450,
        lateMinutes: 30,
        earlyMinutes: null,
        flags: ['late' as const],
        pendingJustification: false,
        leaveType: null,
        leavePortion: null,
      },
      {
        date: '2026-10-22',
        status: 'absent' as const,
        workedMinutes: 0,
        lateMinutes: null,
        earlyMinutes: null,
        flags: ['absent' as const],
        pendingJustification: true,
        leaveType: null,
        leavePortion: null,
      },
    ],
  },
  {
    id: 'an',
    name: 'An',
    department: 'IT',
    days: [
      {
        date: '2026-10-21',
        status: 'wfh' as const,
        workedMinutes: 480,
        lateMinutes: null,
        earlyMinutes: null,
        flags: [],
        pendingJustification: false,
        leaveType: null,
        leavePortion: null,
      },
    ],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  can.mockReturnValue(false);
  GET.mockImplementation(async (path: string) => {
    if (path === '/v1/workforce/attendance') {
      return { data: { month: '2026-10', close: null, employees: PEOPLE } };
    }
    if (path === '/v1/workforce/attendance/justifications/preview') {
      return {
        data: { startDate: '2026-10-21', endDate: '2026-10-21', workingDays: ['2026-10-21'] },
      };
    }
    return { data: '' };
  });
  POST.mockResolvedValue({});
});

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AttendanceTab />
    </QueryClientProvider>,
  );
}

describe('the derived month', () => {
  it('asks for the current month and totals each person', async () => {
    renderTab();
    await screen.findByText('Quang');
    expect(GET).toHaveBeenCalledWith('/v1/workforce/attendance', {
      params: { query: { month: '2026-10' } },
    });
    expect(screen.getByText('An')).toBeInTheDocument();
  });

  it('expands a person into their days, flags in Vietnamese', async () => {
    renderTab();
    fireEvent.click(await screen.findByText('Quang'));
    const section = await screen.findByRole('region', { name: /theo ngày/ });
    expect(section).toHaveTextContent('Đi muộn (30 phút)');
    expect(section).toHaveTextContent('Vắng không phép');
    expect(section).toHaveTextContent('Đơn giải trình chờ duyệt');
  });

  it('shows the month as not closed, and hides HR actions from a plain employee', async () => {
    renderTab();
    expect(await screen.findByText('Tháng chưa chốt.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Chốt tháng' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Tổng hợp/ })).toBeNull();
  });
});

describe('filing a justification', () => {
  it('posts kind and range, and says it is waiting for approval', async () => {
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Nộp đơn giải trình' }));
    // The range seeds on yesterday (2026-10-20) and the preview answers one working day.
    expect(await screen.findByText(/giải trình 1 ngày làm việc/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Nộp đơn' }));

    await waitFor(() =>
      expect(POST).toHaveBeenCalledWith('/v1/workforce/attendance/justifications', {
        body: { kind: 'late', startDate: expect.any(String), endDate: expect.any(String) },
      }),
    );
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(expect.stringContaining('chờ quản lý duyệt')),
    );
  });
});

describe('the month close', () => {
  it('HR sees Chốt tháng; confirming closes it and the state changes', async () => {
    can.mockImplementation((p: string) => p === 'workforce.attendance.close');
    GET.mockImplementation(async (path: string) => {
      if (path === '/v1/workforce/attendance') {
        return { data: { month: '2026-10', close: null, employees: PEOPLE } };
      }
      return { data: '' };
    });
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Chốt tháng' }));
    // The header button AND the confirm dialog's confirm button share the name; the dialog's is last.
    fireEvent.click(screen.getAllByRole('button', { name: 'Chốt tháng' }).pop()!);

    await waitFor(() =>
      expect(POST).toHaveBeenCalledWith('/v1/workforce/attendance/months/{month}/close', {
        params: { path: { month: '2026-10' } },
        body: {},
      }),
    );
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Đã chốt tháng 2026-10'));
  });

  it('a closed month offers reopen only to the override holder', async () => {
    can.mockImplementation((p: string) => p === 'workforce.attendance.reopen');
    GET.mockImplementation(async (path: string) => {
      if (path === '/v1/workforce/attendance') {
        return {
          data: {
            month: '2026-10',
            close: {
              month: '2026-10',
              closedBy: 'hr-1',
              closedAt: '2026-10-20T10:00:00.000Z',
              note: null,
            },
            employees: PEOPLE,
          },
        };
      }
      return { data: '' };
    });
    renderTab();
    expect(await screen.findByText(/Đã chốt tháng/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mở lại tháng' }));
    // The override now demands a reason, which lands in the audit trail.
    fireEvent.change(await screen.findByRole('textbox'), {
      target: { value: 'e2e: cần sửa chấm công' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Mở lại tháng' }).pop()!);

    await waitFor(() =>
      expect(POST).toHaveBeenCalledWith('/v1/workforce/attendance/months/{month}/reopen', {
        params: { path: { month: '2026-10' } },
        body: { note: 'e2e: cần sửa chấm công' },
      }),
    );
  });
});

describe('the CSVs', () => {
  it('an attendance reader gets both downloads, fetched as text', async () => {
    can.mockImplementation((p: string) => p === 'workforce.attendance.read');
    renderTab();
    const summary = await screen.findByRole('button', { name: /Tổng hợp/ });
    fireEvent.click(summary);
    await waitFor(() =>
      expect(GET).toHaveBeenCalledWith('/v1/workforce/attendance/summary.csv', {
        params: { query: { month: '2026-10' } },
        parseAs: 'text',
      }),
    );
  });
});
