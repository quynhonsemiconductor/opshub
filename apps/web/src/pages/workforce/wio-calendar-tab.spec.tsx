// @vitest-environment jsdom
/**
 * THE WIO CALENDAR — what a person sees, and what filing a WFH request does.
 *
 * The API is replaced by a tiny fake server that keeps the marks in memory, because the interesting
 * behaviour is a round trip: request → the server answers (or refuses) → the calendar refetches and
 * settles on the server's answer.
 *
 * "Today" is fixed to Wednesday 21 Oct 2026 for the same reason `leave-tab.spec.tsx` fixes it: the
 * grid depends on the month, and the request modal's date floor depends on the date.
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
vi.mock('@/shared/hooks/use-current-user', () => ({
  useCurrentUser: () => ({ data: { sub: 'me' } }),
}));

vi.setSystemTime(new Date('2026-10-21T12:00:00'));

import { WioCalendarTab } from './wio-calendar-tab';

const PEOPLE = [
  { id: 'me', name: 'Quang', department: 'Management' },
  { id: 'an', name: 'An', department: 'IT' },
  { id: 'binh', name: 'Binh', department: null },
];

interface Mark {
  employeeId: string;
  date: string;
  status: 'approved' | 'pending';
}

let marks: Mark[];
let pto: { employeeId: string; date: string; portion: string }[];
let holidays: { date: string; name: string }[];

beforeEach(() => {
  vi.clearAllMocks();
  marks = [{ employeeId: 'binh', date: '2026-10-22', status: 'approved' }];
  pto = [];
  holidays = [];
  GET.mockImplementation(
    async (
      path: string,
      init: {
        params: { query: { month?: string; startDate?: string; endDate?: string } };
      },
    ) => {
      if (path === '/v1/workforce/wfh/preview') {
        // The same arithmetic the server does, for the ranges these tests file.
        const days: string[] = [];
        for (
          let d = new Date(init.params.query.startDate!);
          d <= new Date(init.params.query.endDate!);
          d.setDate(d.getDate() + 1)
        ) {
          const iso = d.toISOString().slice(0, 10);
          const weekday = d.getUTCDay();
          if (weekday !== 0 && weekday !== 6) days.push(iso);
        }
        return {
          data: {
            startDate: init.params.query.startDate!,
            endDate: init.params.query.endDate!,
            workingDays: days,
          },
        };
      }
      const month = init.params.query.month!;
      return {
        data: {
          month,
          people: PEOPLE,
          wfh: marks.filter((m) => m.date.startsWith(month)),
          pto: pto.filter((m) => m.date.startsWith(month)),
          holidays: holidays.filter((m) => m.date.startsWith(month)),
        },
      };
    },
  );
  POST.mockImplementation(
    async (_path: string, init: { body: { startDate: string; endDate: string } }) => {
      const { startDate, endDate } = init.body;
      for (let d = new Date(startDate); d <= new Date(endDate); d.setDate(d.getDate() + 1)) {
        const date = d.toISOString().slice(0, 10);
        marks = marks.filter((m) => !(m.employeeId === 'me' && m.date === date));
        marks.push({ employeeId: 'me', date, status: 'pending' });
      }
      return {};
    },
  );
});

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <WioCalendarTab />
    </QueryClientProvider>,
  );
}

// Matched with functions, not `new RegExp(name)`: a pattern built from a variable is what Semgrep flags as a
// ReDoS risk, and a plain string comparison says the same thing without one.
const day = (name: string) =>
  screen.findByRole('button', { name: (accessible) => accessible.startsWith(`${name}:`) });

describe('WIO calendar', () => {
  it('counts a day as in the office for everyone nobody asked about, WFH for approved marks', async () => {
    renderTab();
    expect(await day('21 October 2026')).toHaveAccessibleName(
      '21 October 2026: 3 in the office, 0 working from home, 0 WFH pending, 0 on PTO',
    );
    expect(await day('22 October 2026')).toHaveAccessibleName(
      '22 October 2026: 2 in the office, 1 working from home, 0 WFH pending, 0 on PTO',
    );
  });

  it('lists names under each group for the selected day', async () => {
    renderTab();
    fireEvent.click(await day('22 October 2026'));
    const section = await screen.findByRole('region', { name: /22 October 2026/ });
    expect(section).toHaveTextContent('In the office (2)');
    expect(section).toHaveTextContent('Working from home (1)');
    expect(section).toHaveTextContent('Binh');
  });

  it('keeps a PENDING mark out of both lists, in its own awaiting-approval group', async () => {
    marks = [
      { employeeId: 'binh', date: '2026-10-22', status: 'approved' },
      { employeeId: 'an', date: '2026-10-22', status: 'pending' },
    ];
    renderTab();
    expect(await day('22 October 2026')).toHaveAccessibleName(
      '22 October 2026: 1 in the office, 1 working from home, 1 WFH pending, 0 on PTO',
    );
    fireEvent.click(await day('22 October 2026'));
    const section = await screen.findByRole('region', { name: /22 October 2026/ });
    expect(section).toHaveTextContent('WFH, awaiting approval (1)');
    expect(section).toHaveTextContent('An');
  });

  it('filing a WFH request posts the window and refetches the month', async () => {
    renderTab();
    fireEvent.click(await day('23 October 2026'));
    fireEvent.click(screen.getByRole('button', { name: 'Request WFH' }));
    // The modal's range starts on the selected day; submit it as that single day.
    fireEvent.click(await screen.findByRole('button', { name: 'Request' }));

    await waitFor(() =>
      expect(POST).toHaveBeenCalledWith('/v1/workforce/wfh', {
        body: { startDate: '2026-10-23', endDate: '2026-10-23' },
      }),
    );
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('WFH request submitted'));
    // The new mark arrives as PENDING, so the day reads one pending and nobody moved out of the office.
    expect(await day('23 October 2026')).toHaveAccessibleName(
      '23 October 2026: 2 in the office, 0 working from home, 1 WFH pending, 0 on PTO',
    );
  });

  it('shows the working-day count from the preview before submit', async () => {
    renderTab();
    // The default range is the selected day, Friday 23 Oct: one working day.
    fireEvent.click(await day('23 October 2026'));
    fireEvent.click(screen.getByRole('button', { name: 'Request WFH' }));
    expect(await screen.findByText(/Covers 1 working day/)).toBeInTheDocument();
  });

  it('says why when the server refuses the request', async () => {
    POST.mockResolvedValueOnce({
      error: {
        error: {
          code: 'WFH_OVERLAPPING',
          message: 'You already have a leave or WFH request covering part of that window',
        },
      },
    });
    renderTab();
    fireEvent.click(await day('23 October 2026'));
    fireEvent.click(screen.getByRole('button', { name: 'Request WFH' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Request' }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(await day('23 October 2026')).toHaveAccessibleName(
      '23 October 2026: 3 in the office, 0 working from home, 0 WFH pending, 0 on PTO',
    );
  });

  it('renders a holiday day with its name and nobody expected in', async () => {
    holidays = [{ date: '2026-10-26', name: 'Tết Dương Lịch' }];
    renderTab();
    // The day is not a button any more: it says the holiday name instead of counts.
    expect(await screen.findByText('Tết Dương Lịch')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: (a: string) => a.startsWith('26 October 2026:') }),
    ).toBeNull();
    fireEvent.click(await day('27 October 2026'));
    expect(await screen.findByRole('region', { name: /27 October 2026/ })).toBeInTheDocument();
  });

  it('counts and lists people on leave in their own PTO column', async () => {
    pto = [
      { employeeId: 'an', date: '2026-10-27', portion: 'full_day' },
      { employeeId: 'binh', date: '2026-10-27', portion: 'full_day' },
      { employeeId: 'me', date: '2026-10-28', portion: 'morning' },
    ];
    renderTab();
    expect(await day('27 October 2026')).toHaveAccessibleName(
      '27 October 2026: 1 in the office, 0 working from home, 0 WFH pending, 2 on PTO',
    );
    fireEvent.click(await day('27 October 2026'));
    const section = await screen.findByRole('region', { name: /27 October 2026/ });
    expect(section).toHaveTextContent('On PTO (2)');
    expect(section).toHaveTextContent('In the office (1)');
  });

  it('keeps somebody on half-day leave in the office list and says which half', async () => {
    pto = [{ employeeId: 'an', date: '2026-10-28', portion: 'morning' }];
    renderTab();
    fireEvent.click(await day('28 October 2026'));
    const section = await screen.findByRole('region', { name: /28 October 2026/ });
    expect(section).toHaveTextContent('In the office (3)');
    expect(section).toHaveTextContent('off this morning');
    expect(section).toHaveTextContent('On PTO (0)');
  });

  it('asks for the next month when you page forward', async () => {
    renderTab();
    await day('21 October 2026');
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    expect(await screen.findByRole('heading', { name: 'November 2026' })).toBeInTheDocument();
    await waitFor(() =>
      expect(GET).toHaveBeenCalledWith('/v1/workforce/wio-calendar', {
        params: { query: { month: '2026-11' } },
      }),
    );
  });

  it('reports a failed load instead of showing everybody as in the office', async () => {
    GET.mockResolvedValue({ error: { code: 'INTERNAL' } });
    renderTab();
    expect(await screen.findByText('Failed to load the WIO calendar.')).toBeInTheDocument();
    expect(screen.queryByText(/in office/)).toBeNull();
  });
});
