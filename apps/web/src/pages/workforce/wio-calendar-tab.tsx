import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/shared/api/client';
import { apiErrorMessage } from '@/shared/api/errors';
import { useCurrentUser } from '@/shared/hooks/use-current-user';
import { cn } from '@/shared/lib/utils';
import { Button, Checkbox, PanelState } from '@/shared/ui';
import { MONTHS, WEEKDAYS, dayName, monthCells, parseIso, toIso } from '@/shared/ui/date-grid';
import {
  indexMonth,
  isEditable,
  isWorkday,
  monthKey,
  shiftMonth,
  summariseDay,
  withMark,
  type MonthIndex,
  type PtoPortion,
  type WioMonth,
  type WioPerson,
} from './wio-calendar-model';

/**
 * WIO calendar — who is in the office, who works from home, day by day.
 *
 * One flag per person per day, set by that person. A day nobody marked is a day everybody is in the
 * office, so there is nothing to fill in: ticking a box means "I'm working from home".
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
  // Days with a request in flight. A second click on the same day would send a second PUT that can reach the
  // server out of order, and a failure of one would roll back over the other's optimistic change.
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());

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

  const setDay = useMutation({
    mutationFn: async ({ iso, wfh }: { iso: string; wfh: boolean }) => {
      const { error } = await api.PUT('/v1/workforce/wio-calendar/{date}', {
        params: { path: { date: iso } },
        body: { wfh },
      });
      if (error) throw error;
    },
    // Optimistic: the box must answer the click now, and the server only ever agrees or refuses.
    onMutate: async ({ iso, wfh }) => {
      setBusy((b) => new Set(b).add(iso));
      await qc.cancelQueries({ queryKey });
      const previous = qc.getQueryData<WioMonth>(queryKey);
      if (previous && me.data) qc.setQueryData(queryKey, withMark(previous, iso, me.data.sub, wfh));
      return { previous };
    },
    onError: (error, _vars, context) => {
      if (context?.previous) qc.setQueryData(queryKey, context.previous);
      toast.error(apiErrorMessage(error, 'Could not update that day.'));
    },
    onSettled: (_data, _error, { iso }) => {
      setBusy((b) => {
        const next = new Set(b);
        next.delete(iso);
        return next;
      });
      return qc.invalidateQueries({ queryKey });
    },
  });

  const people = calendar.data?.people ?? [];
  const index = indexMonth(calendar.data);
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
        <p className="text-xs text-fg-subtle">
          Everyone is in the office unless they tick <span className="font-medium">WFH</span> or
          have approved leave (PTO).
        </p>
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
                myId={myId}
                editable={isEditable(iso, todayIso) && !busy.has(iso)}
                onSelect={() => setSelected(iso)}
                onToggle={(wfh) => setDay.mutate({ iso, wfh })}
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
  myId,
  editable,
  onSelect,
  onToggle,
}: {
  iso: string;
  inMonth: boolean;
  isToday: boolean;
  isSelected: boolean;
  people: WioPerson[];
  index: MonthIndex;
  myId: string | undefined;
  editable: boolean;
  onSelect: () => void;
  onToggle: (wfh: boolean) => void;
}) {
  const dayNumber = Number(iso.slice(8));

  // Days of the neighbouring months fill the grid but their marks are not loaded, so they say nothing.
  // Weekends are not working days: nobody is expected in, so no counts and no box.
  if (!inMonth || !isWorkday(iso)) {
    return (
      <div className="min-h-28 rounded-md bg-surface-muted/50 p-2 text-xs text-fg-subtle/70">
        {dayNumber}
      </div>
    );
  }

  const { wfh, office, pto } = summariseDay(iso, people, index);
  // On leave all day: a WFH tick would mean nothing, so the box is off and shows unticked.
  const onPto = myId !== undefined && index.pto.get(iso)?.get(myId) === 'full_day';
  const mine = !onPto && myId !== undefined && index.wfh.get(iso)?.has(myId) === true;

  return (
    <div
      className={cn(
        'flex min-h-28 flex-col justify-between gap-1.5 rounded-md border bg-surface p-2',
        isSelected ? 'border-accent ring-1 ring-accent' : 'border-border',
        mine && 'bg-accent-muted',
      )}
    >
      <Button
        variant="ghost"
        onClick={onSelect}
        aria-pressed={isSelected}
        aria-label={`${dayName(iso)}: ${office.length} in the office, ${wfh.length} working from home, ${pto.length} on PTO`}
        className="h-auto flex-col items-start justify-start gap-0.5 p-0.5 text-left hover:bg-transparent"
      >
        <span
          className={cn(
            'text-xs font-semibold',
            isToday
              ? 'rounded-full bg-accent px-1.5 text-accent-fg'
              : editable
                ? 'text-fg'
                : 'text-fg-subtle',
          )}
        >
          {dayNumber}
        </span>
        <span className="text-xs text-success">{office.length} in office</span>
        <span className="text-xs text-warning">{wfh.length} WFH</span>
        <span className="text-xs text-accent">{pto.length} PTO</span>
      </Button>
      <Checkbox
        size="sm"
        checked={mine}
        disabled={!editable || myId === undefined || onPto}
        onChange={(checked) => onToggle(checked)}
        label={
          // The visible word is hidden from assistive tech and a full phrase stands in for it: twenty-odd
          // boxes all named "WFH" are indistinguishable by ear, and "WFH" + a trailing span glued into
          // "WFHon 23 October" because name computation trims each piece's edge space.
          <>
            <span aria-hidden="true">WFH</span>
            <span className="sr-only">WFH on {dayName(iso)}</span>
          </>
        }
      />
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
  if (!isWorkday(iso)) {
    return (
      <p className="text-xs text-fg-subtle">
        {dayName(iso)} is a weekend, so nobody is expected in the office.
      </p>
    );
  }
  const { wfh, office, pto, partial } = summariseDay(iso, people, index);
  return (
    <section
      aria-label={`Who is where on ${dayName(iso)}`}
      className="grid gap-4 rounded-lg border border-border bg-surface p-4 sm:grid-cols-3"
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
  /** Half-day leave by person id, shown as a muted note; absent for the PTO list itself. */
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
