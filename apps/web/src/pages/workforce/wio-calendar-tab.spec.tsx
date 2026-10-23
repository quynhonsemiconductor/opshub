// @vitest-environment jsdom
/**
 * THE WIO CALENDAR — what a person sees and what ticking a box does.
 *
 * The API is replaced by a tiny fake server that keeps the marks in memory, because the interesting
 * behaviour is a round trip: tick → the count moves at once → the server agrees (or refuses) → the
 * screen settles on the server's answer. A static GET mock cannot show that, it would snap every
 * optimistic change straight back on the refetch.
 *
 * "Today" is fixed to Wednesday 21 Oct 2026 for the same reason `leave-tab.spec.tsx` fixes it: which
 * days are editable depends on the date, and the grid depends on the month.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const GET = vi.fn();
const PUT = vi.fn();
const toastError = vi.fn();

vi.mock('@/shared/api/client', () => ({
  api: { GET: (...a: unknown[]) => GET(...a), PUT: (...a: unknown[]) => PUT(...a) },
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: (...a: unknown[]) => toastError(...a) },
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

let marks: { employeeId: string; date: string }[];
let pto: { employeeId: string; date: string; portion: string }[];

beforeEach(() => {
  vi.clearAllMocks();
  marks = [{ employeeId: 'binh', date: '2026-10-22' }];
  pto = [];
  GET.mockImplementation(async (_path: string, init: { params: { query: { month: string } } }) => ({
    data: {
      month: init.params.query.month,
      people: PEOPLE,
      wfh: marks.filter((m) => m.date.startsWith(init.params.query.month)),
      pto: pto.filter((m) => m.date.startsWith(init.params.query.month)),
    },
  }));
  PUT.mockImplementation(
    async (_path: string, init: { params: { path: { date: string } }; body: { wfh: boolean } }) => {
      const date = init.params.path.date;
      marks = marks.filter((m) => !(m.employeeId === 'me' && m.date === date));
      if (init.body.wfh) marks.push({ employeeId: 'me', date });
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

const day = (name: string) => screen.findByRole('button', { name: new RegExp(`^${name}:`) });
const box = (name: string) => screen.findByRole('checkbox', { name: new RegExp(`WFH on ${name}`) });

describe('WIO calendar', () => {
  it('counts a day as in the office for everyone nobody marked, and WFH for those who did', async () => {
    renderTab();
    expect(await day('21 October 2026')).toHaveAccessibleName(
      '21 October 2026: 3 in the office, 0 working from home, 0 on PTO',
    );
    expect(await day('22 October 2026')).toHaveAccessibleName(
      '22 October 2026: 2 in the office, 1 working from home, 0 on PTO',
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

  it('offers a box only on today and later working days', async () => {
    renderTab();
    expect(await box('21 October 2026')).toBeEnabled(); // today
    expect(await box('23 October 2026')).toBeEnabled(); // Friday
    expect(await box('20 October 2026')).toBeDisabled(); // yesterday
    // Saturday 24th has no box at all: nobody is expected in on a weekend.
    expect(screen.queryByRole('checkbox', { name: /24 October 2026/ })).toBeNull();
  });

  it('ticking WFH moves the person at once and sends the day to the server', async () => {
    renderTab();
    fireEvent.click(await box('23 October 2026'));

    await waitFor(() =>
      expect(PUT).toHaveBeenCalledWith('/v1/workforce/wio-calendar/{date}', {
        params: { path: { date: '2026-10-23' } },
        body: { wfh: true },
      }),
    );
    expect(await day('23 October 2026')).toHaveAccessibleName(
      '23 October 2026: 2 in the office, 1 working from home, 0 on PTO',
    );
    expect(await box('23 October 2026')).toBeChecked();
  });

  it('unticking sends wfh: false and puts the person back in the office', async () => {
    marks.push({ employeeId: 'me', date: '2026-10-23' });
    renderTab();
    const checkbox = await box('23 October 2026');
    await waitFor(() => expect(checkbox).toBeChecked());
    fireEvent.click(checkbox);

    await waitFor(() =>
      expect(PUT).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ body: { wfh: false } }),
      ),
    );
    expect(await day('23 October 2026')).toHaveAccessibleName(
      '23 October 2026: 3 in the office, 0 working from home, 0 on PTO',
    );
  });

  it('locks that day while its request is in flight, so a fast second click cannot race the first', async () => {
    let finish!: () => void;
    PUT.mockImplementationOnce(() => new Promise((resolve) => (finish = () => resolve({}))));
    renderTab();
    const checkbox = await box('23 October 2026');
    fireEvent.click(checkbox);

    await waitFor(() => expect(checkbox).toBeDisabled());
    // Another day is unaffected.
    expect(await box('22 October 2026')).toBeEnabled();

    finish();
    await waitFor(() => expect(checkbox).toBeEnabled());
    expect(PUT).toHaveBeenCalledTimes(1);
  });

  it('puts the box back and says why when the server refuses', async () => {
    PUT.mockResolvedValueOnce({
      error: {
        error: {
          code: 'WFH_DAY_NOT_EDITABLE',
          message: 'A day that has already passed cannot be changed',
        },
      },
    });
    renderTab();
    fireEvent.click(await box('23 October 2026'));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(await box('23 October 2026')).not.toBeChecked();
    expect(await day('23 October 2026')).toHaveAccessibleName(
      '23 October 2026: 3 in the office, 0 working from home, 0 on PTO',
    );
  });

  it('counts and lists people on leave in their own PTO column', async () => {
    pto = [
      { employeeId: 'an', date: '2026-10-26', portion: 'full_day' },
      { employeeId: 'binh', date: '2026-10-26', portion: 'full_day' },
      { employeeId: 'me', date: '2026-10-27', portion: 'morning' },
    ];
    renderTab();
    expect(await day('26 October 2026')).toHaveAccessibleName(
      '26 October 2026: 1 in the office, 0 working from home, 2 on PTO',
    );
    fireEvent.click(await day('26 October 2026'));
    const section = await screen.findByRole('region', { name: /26 October 2026/ });
    expect(section).toHaveTextContent('On PTO (2)');
    expect(section).toHaveTextContent('In the office (1)');
  });

  it('keeps somebody on half-day leave in the office list and says which half', async () => {
    pto = [{ employeeId: 'an', date: '2026-10-27', portion: 'morning' }];
    renderTab();
    fireEvent.click(await day('27 October 2026'));
    const section = await screen.findByRole('region', { name: /27 October 2026/ });
    expect(section).toHaveTextContent('In the office (3)');
    expect(section).toHaveTextContent('off this morning');
    expect(section).toHaveTextContent('On PTO (0)');
  });

  it('switches the WFH box off for a day you are on leave all day', async () => {
    pto = [{ employeeId: 'me', date: '2026-10-26', portion: 'full_day' }];
    renderTab();
    expect(await box('26 October 2026')).toBeDisabled();
    expect(await box('26 October 2026')).not.toBeChecked();
    expect(await box('27 October 2026')).toBeEnabled();
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
