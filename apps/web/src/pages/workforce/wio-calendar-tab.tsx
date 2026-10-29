import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '@/shared/api/client';
import { useCurrentUser } from '@/shared/hooks/use-current-user';
import { cn } from '@/shared/lib/utils';
import { toast } from 'sonner';
import { apiErrorMessage } from '@/shared/api/errors';
import { Button, ConfirmDialog, PanelState, StatusBadge, humanizeStatus } from '@/shared/ui';
import { MONTHS, WEEKDAYS, dayName, monthCells, parseIso, toIso } from '@/shared/ui/date-grid';
import {
  indexMonth,
  isWorkday,
  monthKey,
  shiftMonth,
  summariseDay,
  type MonthIndex,
  type PtoPortion,
  type WioPerson,
} from './wio-calendar-model';
import { RequestWfhModal } from './request-wfh-modal';

/** The status ladder for a WFH request badge. */
const WFH_TONES = { approved: 'green', pending: 'amber', rejected: 'red' } as const;
const wfhTone = (status: string) => WFH_TONES[status as keyof typeof WFH_TONES] ?? 'neutral';

/**
 * WIO calendar — who is in the office, who works from home, day by day.
 *
 * WFH is a manager-approved request now (owner rules 2026-10-28), not a self-tick: the calendar draws
 * a day as WFH only when a request covering it is approved, and shows a pending request as pending —
 * the manager may still say no. Filing one is the button in the header; approving one happens in the
 * requests inbox like leave.
 *
 * The month is fetched whole for everyone (one request per month shown) and each day's lists are derived
 * from it, so changing the selected day costs nothing.
 */
export function WioCalendarTab() {
  const qc = useQueryClient();
  const me = useCurrentUser();
  const todayIso = toIso(new Date());
  const [view, setView] = useState(() => {
    const t = parseIso(todayIso)!;
    return { y: t.y, m: t.m - 1 };
  });
  const [selected, setSelected] = useState(todayIso);
  const [wfhModal, setWfhModal] = useState<{ open: boolean; date?: string }>({ open: false });
  const [withdrawFrom, setWithdrawFrom] = useState<string | null>(null);

  const month = monthKey(view);
  const queryKey = ['workforce', 'wio-calendar', month] as const;

  const calendar = useQuery({
    queryKey,
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/workforce/wio-calendar', {
        params: { query: { month } },
      });
      if (error || !data) throw new Error('Failed to load the WIO calendar');
      return data;
    },
  });

  // The caller's OWN requests — filed from anywhere, withdrawn from here. Self-narrowed by the API.
  const myRequests = useQuery({
    queryKey: ['workforce', 'wfh', 'mine'],
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/workforce/wfh', {
        params: { query: { limit: 50 } },
      });
      if (error || !data) throw new Error('Failed to load your WFH requests');
      return data.data;
    },
  });

  const withdraw = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await api.POST('/v1/workforce/wfh/{id}/cancel', {
        params: { path: { id } },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('WFH request withdrawn');
      setWithdrawFrom(null);
      return Promise.all([
        qc.invalidateQueries({ queryKey: ['workforce', 'wfh'] }),
        qc.invalidateQueries({ queryKey: ['workforce', 'wio-calendar'] }),
      ]);
    },
    onError: (error) => toast.error(apiErrorMessage(error, 'Could not withdraw that request.')),
  });

  const people = calendar.data?.people ?? [];
  const index = useMemo(() => indexMonth(calendar.data), [calendar.data]);
  const myId = me.data?.sub;
  const selectedInView = selected.slice(0, 7) === month;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Previous month"
            onClick={() => setView((v) => shiftMonth(v, -1))}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <h2 className="min-w-36 text-center text-sm font-semibold text-fg" aria-live="polite">
            {MONTHS[view.m]} {view.y}
          </h2>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Next month"
            onClick={() => setView((v) => shiftMonth(v, 1))}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button
            size="sm"
            variant="default"
            onClick={() => {
              const t = parseIso(todayIso)!;
              setView({ y: t.y, m: t.m - 1 });
              setSelected(todayIso);
            }}
          >
            Today
          </Button>
        </div>
        <div className="flex items-center gap-3">
          <p className="text-xs text-fg-subtle">
            Everyone is in the office unless they have an approved{' '}
            <span className="font-medium">WFH</span> request or approved leave (PTO).
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setWfhModal({ open: true, date: selected })}
          >
            Request WFH
          </Button>
        </div>
      </div>

      <PanelState
        query={calendar}
        count={people.length}
        empty="Nobody to show yet."
        error="Failed to load the WIO calendar."
      />

      {calendar.data && people.length > 0 && (
        <>
          <div
            className="grid grid-cols-7 gap-1.5"
            role="group"
            aria-label={`${MONTHS[view.m]} ${view.y}`}
          >
            {WEEKDAYS.map((d) => (
              <div key={d} className="px-1 text-center text-xs font-medium text-fg-subtle">
                {d}
              </div>
            ))}
            {visibleCells(view, month).map((iso) => (
              <DayCell
                key={iso}
                iso={iso}
                inMonth={iso.slice(0, 7) === month}
                isToday={iso === todayIso}
                isSelected={iso === selected}
                people={people}
                index={index}
                onSelect={() => setSelected(iso)}
              />
            ))}
          </div>

          {selectedInView ? (
            <DayDetail iso={selected} people={people} index={index} myId={myId} />
          ) : (
            <p className="text-xs text-fg-subtle">Select a day to see who is in the office.</p>
          )}
        </>
      )}

      {myRequests.data && myRequests.data.length > 0 && (
        <section
          aria-label="Your WFH requests"
          className="rounded-lg border border-border bg-surface p-4"
        >
          <h3 className="mb-2 text-xs font-semibold text-fg-subtle">Your WFH requests</h3>
          <ul className="flex flex-col gap-1.5">
            {myRequests.data.map((r) => (
              <li key={r.id} className="flex flex-wrap items-baseline gap-2 text-sm">
                <span className="text-fg-subtle">
                  {r.startDate === r.endDate ? r.startDate : `${r.startDate} → ${r.endDate}`}
                </span>
                <span className="text-fg-subtle">
                  ({r.workingDays} working {r.workingDays === 1 ? 'day' : 'days'})
                </span>
                <StatusBadge tone={wfhTone(r.status)}>{humanizeStatus(r.status)}</StatusBadge>
                {r.status === 'pending' && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setWithdrawFrom(r.id)}
                    aria-label={`Withdraw the WFH request for ${r.startDate}`}
                  >
                    Withdraw
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Conditionally mounted, so each open starts from the selected day: the modal holds the date
          range in state, and a second open would otherwise keep the previous open's range. */}
      {wfhModal.open && (
        <RequestWfhModal
          open={wfhModal.open}
          initialDate={wfhModal.date}
          onClose={() => setWfhModal({ open: false })}
          onSuccess={() => {
            // A new request shows up as a pending mark for every month it touches, not just this one.
            void Promise.all([
              qc.invalidateQueries({ queryKey: ['workforce', 'wio-calendar'] }),
              qc.invalidateQueries({ queryKey: ['workforce', 'wfh'] }),
            ]);
          }}
        />
      )}
      <ConfirmDialog
        open={withdrawFrom !== null}
        title="Withdraw this WFH request?"
        description="The manager waiting on it is told it is gone. An APPROVED request cannot be withdrawn — file a new one and the overlap rule keeps the change honest."
        confirmLabel="Withdraw"
        loading={withdraw.isPending}
        onConfirm={() => withdrawFrom && withdraw.mutate(withdrawFrom)}
        onCancel={() => setWithdrawFrom(null)}
      />
    </div>
  );
}

/** `monthCells` always returns six weeks; the sixth is dropped when it holds no day of this month. */
function visibleCells(view: { y: number; m: number }, month: string): string[] {
  const cells = monthCells(view);
  return cells.slice(35).some((iso) => iso.slice(0, 7) === month) ? cells : cells.slice(0, 35);
}

function DayCell({
  iso,
  inMonth,
  isToday,
  isSelected,
  people,
  index,
  onSelect,
}: {
  iso: string;
  inMonth: boolean;
  isToday: boolean;
  isSelected: boolean;
  people: WioPerson[];
  index: MonthIndex;
  onSelect: () => void;
}) {
  const dayNumber = Number(iso.slice(8));
  const holiday = index.holidays.get(iso);

  // Days of the neighbouring months fill the grid but their marks are not loaded, so they say nothing.
  // Weekends are not working days: nobody is expected in, so no counts.
  if (!inMonth || !isWorkday(iso)) {
    return (
      <div className="min-h-28 rounded-md bg-surface-muted/50 p-2 text-xs text-fg-subtle/70">
        {dayNumber}
      </div>
    );
  }

  // A holiday has nobody expected in, whatever the requests say — the ladder the API applies too.
  if (holiday) {
    return (
      <div
        className={cn(
          'flex min-h-28 flex-col justify-between gap-1.5 rounded-md border border-dashed border-border bg-surface-muted/50 p-2',
          isSelected && 'ring-1 ring-accent',
        )}
      >
        <span
          className={cn(
            'text-xs font-semibold',
            isToday ? 'rounded-full bg-accent px-1.5 text-accent-fg' : 'text-fg-subtle',
          )}
        >
          {dayNumber}
        </span>
        <span className="text-xs text-accent" title={holiday}>
          {holiday}
        </span>
      </div>
    );
  }

  const { wfh, pendingWfh, office, pto } = summariseDay(iso, people, index);

  return (
    <div
      className={cn(
        'flex min-h-28 flex-col justify-between gap-1.5 rounded-md border bg-surface p-2',
        isSelected ? 'border-accent ring-1 ring-accent' : 'border-border',
      )}
    >
      <Button
        variant="ghost"
        onClick={onSelect}
        aria-pressed={isSelected}
        aria-label={`${dayName(iso)}: ${office.length} in the office, ${wfh.length} working from home, ${pendingWfh.length} WFH pending, ${pto.length} on PTO`}
        className="h-auto flex-col items-start justify-start gap-0.5 p-0.5 text-left hover:bg-transparent"
      >
        <span
          className={cn(
            'text-xs font-semibold',
            isToday ? 'rounded-full bg-accent px-1.5 text-accent-fg' : 'text-fg',
          )}
        >
          {dayNumber}
        </span>
        <span className="text-xs text-success">{office.length} in office</span>
        <span className="text-xs text-warning">{wfh.length} WFH</span>
        {pendingWfh.length > 0 && (
          <span className="text-xs text-fg-subtle">{pendingWfh.length} WFH pending</span>
        )}
        <span className="text-xs text-accent">{pto.length} PTO</span>
      </Button>
    </div>
  );
}

function DayDetail({
  iso,
  people,
  index,
  myId,
}: {
  iso: string;
  people: WioPerson[];
  index: MonthIndex;
  myId: string | undefined;
}) {
  const holiday = index.holidays.get(iso);
  if (holiday) {
    return (
      <p className="text-xs text-fg-subtle">
        {dayName(iso)} is <span className="text-accent">{holiday}</span> — a public holiday, so
        nobody is expected in the office.
      </p>
    );
  }
  if (!isWorkday(iso)) {
    return (
      <p className="text-xs text-fg-subtle">
        {dayName(iso)} is a weekend, so nobody is expected in the office.
      </p>
    );
  }
  const { wfh, pendingWfh, office, pto, partial } = summariseDay(iso, people, index);
  return (
    <section
      aria-label={`Who is where on ${dayName(iso)}`}
      className="grid gap-4 rounded-lg border border-border bg-surface p-4 sm:grid-cols-4"
    >
      <PeopleList
        title="In the office"
        tone="text-success"
        people={office}
        partial={partial}
        myId={myId}
      />
      <PeopleList
        title="Working from home"
        tone="text-warning"
        people={wfh}
        partial={partial}
        myId={myId}
      />
      <PeopleList
        title="WFH, awaiting approval"
        tone="text-fg-subtle"
        people={pendingWfh}
        myId={myId}
      />
      <PeopleList title="On PTO" tone="text-accent" people={pto} myId={myId} />
    </section>
  );
}

/** What to say beside a person who is off for half the day. */
const PARTIAL_LABEL: Record<Exclude<PtoPortion, 'full_day'>, string> = {
  morning: 'off this morning',
  afternoon: 'off this afternoon',
};

function PartialNote({ portion }: { portion: Exclude<PtoPortion, 'full_day'> | undefined }) {
  return portion ? <span className="text-xs text-accent">{PARTIAL_LABEL[portion]}</span> : null;
}

function PeopleList({
  title,
  tone,
  people,
  partial,
  myId,
}: {
  title: string;
  tone: string;
  people: WioPerson[];
  /** Half-day leave by person id, shown as a muted note; absent for the pending and PTO lists. */
  partial?: Map<string, Exclude<PtoPortion, 'full_day'>>;
  myId: string | undefined;
}) {
  return (
    <div>
      <h3 className={cn('mb-2 text-xs font-semibold', tone)}>
        {title} ({people.length})
      </h3>
      {people.length === 0 ? (
        <p className="text-xs text-fg-subtle">Nobody.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {people.map((p) => (
            <li key={p.id} className="flex items-baseline gap-2 text-sm text-fg">
              <span className={cn(p.id === myId && 'font-semibold')}>
                {p.name}
                {p.id === myId && <span className="font-normal text-fg-subtle"> (you)</span>}
              </span>
              {p.department && <span className="text-xs text-fg-subtle">{p.department}</span>}
              <PartialNote portion={partial?.get(p.id)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
