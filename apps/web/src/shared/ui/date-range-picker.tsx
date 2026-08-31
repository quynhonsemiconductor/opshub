/**
 * DateRangePicker — a from/to window, typed in two fields and picked on ONE calendar.
 *
 * A pair of `type="date"` inputs opens two platform pickers, orders nothing, and hands "to before
 * from" to the API as a 422 — or worse, as data. This emits an ordered `{ from, to }` or `null`.
 *
 * VALIDATION IS AUTO-SWAP, NOT AN ERROR — the one behaviour to know before consuming (see
 * `date-grid.ts`, where the rule lives in code). Nothing is emitted until BOTH ends are complete
 * and real, so a caller never stores a half-typed date. The field being typed into keeps its draft
 * until blur, so on blur it may show the other end of the pair it just reordered.
 *
 * The grid is a real ARIA grid with a roving tab index; disabled days are skipped by the walk,
 * because focus landing on a day that cannot be picked reads as a broken control. No date library
 * was installed, and two components are not the price of admission for one.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { todayIso } from '@/shared/lib/format';
import { FOCUS_RING } from './button';
import { FieldError } from './form-field';
import { RangeField, MonthButton } from './date-range-field';
import {
  MONTHS,
  WEEKDAYS,
  addDays,
  dayName,
  isWellFormedIso,
  monthCells,
  orderRange,
  parseIso,
  toIso,
  type DateRange,
} from './date-grid';

/** Re-exported so the kit stays one import path for the type as well as the component. */
export type { DateRange } from './date-grid';

export interface DateRangePickerProps {
  /** The current window, or `null` for nothing chosen. Ordered here as well as emitted. */
  value: DateRange | null;
  /** The next ordered window, or `null` after the clear button. */
  onChange: (value: DateRange | null) => void;
  /** Earliest selectable day, `YYYY-MM-DD`. Days before it are disabled. */
  min?: string;
  /** Latest selectable day, `YYYY-MM-DD`. Days after it are disabled. */
  max?: string;
  /** Beyond `min`/`max`: per-day unavailability the caller knows and this cannot (booked-out days). */
  isDisabled?: (iso: string) => boolean;
  /** On the From field; To gets `${id}-to`. Point a `FormField` label here to land on From. */
  id?: string;
  disabled?: boolean;
  className?: string;
}

export function DateRangePicker({
  value,
  onChange,
  min,
  max,
  isDisabled,
  id,
  disabled = false,
  className,
}: DateRangePickerProps) {
  const generatedId = useId();
  const rootId = id ?? generatedId;
  const errorId = `${rootId}-error`;
  const titleId = `${rootId}-title`;
  const fromRef = useRef<HTMLInputElement>(null);
  const toRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  /** Which field opened the calendar, so closing hands focus back to IT and not to the other one. */
  const openerRef = useRef<'from' | 'to'>('from');
  /** Focus is being HANDED BACK to the opener — its onFocus must not read that as "open me" again. */
  const returningFocusRef = useRef(false);
  /** The grid asked for focus (ArrowDown, an arrow key): move it after the next render commits. */
  const armGridRef = useRef(false);

  const [open, setOpen] = useState(false);
  const [view, setView] = useState<{ y: number; m: number } | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  /** The first click of a two-click pick: the day awaiting its partner. */
  const [anchor, setAnchor] = useState<string | null>(null);
  /**
   * Half-typed field text, held locally so it is not clobbered while the pair is incomplete.
   *
   * BOTH SIDES, not just the one being typed — the pair has to survive the blur that moving from
   * `from` to `to` fires: nothing is committed until each side has been ENTERED, and if the first
   * side's draft died on that blur, a keyboard-only user could never fill a range starting from
   * empty at all (typing `from`, tabbing to `to`, typing `to` — the pair only ever coming from a
   * `value` that already existed). A side is cleared once it commits, or on blur if what is sitting
   * in it does not parse to a selectable day — an invalid leftover should not survive to confuse
   * the next edit, but a VALID one that is simply waiting for its partner should.
   */
  const [draft, setDraft] = useState<{ from?: string; to?: string }>({});
  const [error, setError] = useState<{ field: 'from' | 'to'; message: string } | null>(null);
  const [today] = useState(() => todayIso());

  const shown = value ? orderRange(value.from, value.to) : null;
  const dayDisabled = (iso: string) =>
    (min !== undefined && iso < min) ||
    (max !== undefined && iso > max) ||
    (isDisabled?.(iso) ?? false);

  /** The nearest selectable day from `start` in `delta`'s direction; capped in case the caller
   * disables everything — a walk that cannot end is worse than a focus that cannot move. */
  const selectable = (start: string, delta: number): string => {
    let iso = start;
    for (let steps = 0; steps < 400 && dayDisabled(iso); steps += 1) iso = addDays(iso, delta);
    return iso;
  };

  function openCalendar(opener: 'from' | 'to') {
    if (disabled) return;
    openerRef.current = opener;
    // The month to show: the pending pick, else the value, else today — nudged into the allowed
    // window (forward first, then back, for a `max` already in the past).
    let start = anchor ?? shown?.from ?? shown?.to ?? today;
    if (dayDisabled(start)) start = selectable(start, 1);
    if (dayDisabled(start)) start = selectable(start, -1);
    setView({ y: Number(start.slice(0, 4)), m: Number(start.slice(5, 7)) - 1 });
    setFocused(start);
    setOpen(true);
  }

  /**
   * `returnFocus` is true where focus has nowhere better to go — Escape, and the second pick. An
   * outside click has already moved focus where the POINTER went, and following it would steal it
   * back.
   */
  function closeCalendar(returnFocus: boolean) {
    setOpen(false);
    setAnchor(null);
    if (returnFocus) {
      returningFocusRef.current = true;
      (openerRef.current === 'from' ? fromRef : toRef).current?.focus();
    }
  }

  function pickDay(iso: string) {
    if (dayDisabled(iso)) return;
    if (anchor === null) {
      // First click: a one-day window, immediately valid, held open for the second click.
      setAnchor(iso);
      setFocused(iso);
      onChange({ from: iso, to: iso });
      return;
    }
    onChange(orderRange(anchor, iso));
    closeCalendar(true);
  }

  function editField(field: 'from' | 'to', text: string) {
    const otherField = field === 'from' ? 'to' : 'from';
    setDraft((d) => ({ ...d, [field]: text }));
    if (text === '') {
      // Clearing one end just leaves half a pair — not an error, and nothing to emit yet.
      setError(null);
    } else if (!parseIso(text)) {
      setError(isWellFormedIso(text) ? { field, message: 'Not a real calendar date.' } : null);
    } else if (dayDisabled(text)) {
      setError({ field, message: 'That date is outside the allowed window.' });
    } else {
      // The partner can be an already-COMMITTED value (`shown`, the normal case: adjusting one end
      // of an existing range) or the OTHER field's own still-uncommitted draft (a range being typed
      // for the first time, where neither side has committed yet).
      const draftOther = draft[otherField];
      const other =
        (draftOther && parseIso(draftOther) && !dayDisabled(draftOther) ? draftOther : undefined) ??
        (field === 'from' ? shown?.to : shown?.from);
      if (other) {
        onChange(orderRange(text, other));
        setDraft({});
      }
      setError(null);
    }
  }

  function onFieldKeyDown(event: React.KeyboardEvent<HTMLInputElement>, field: 'from' | 'to') {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      armGridRef.current = true;
      openCalendar(field);
    } else if (event.key === 'Escape' && open) {
      // Ours first: a picker open inside a `Modal` must not close the modal with the same keypress.
      event.preventDefault();
      event.stopPropagation();
      closeCalendar(true);
    }
  }

  function moveFocused(delta: number) {
    if (!focused) return;
    const next = selectable(addDays(focused, delta), delta);
    armGridRef.current = true;
    setFocused(next);
    setView({ y: Number(next.slice(0, 4)), m: Number(next.slice(5, 7)) - 1 });
  }

  /** Same day-of-month in the neighbouring month, clamped to its length, then to a pickable day. */
  function shiftMonth(delta: number) {
    if (!view || !focused) return;
    const next = new Date(view.y, view.m + delta, 1);
    const y = next.getFullYear();
    const m = next.getMonth();
    const day = Math.min(Number(focused.slice(8)), new Date(y, m + 1, 0).getDate());
    const iso = selectable(toIso(new Date(y, m, day)), delta);
    armGridRef.current = true;
    setView({ y, m });
    setFocused(iso);
  }

  function onGridKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const steps: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
    };
    if (focused && event.key in steps) {
      event.preventDefault();
      moveFocused(steps[event.key]);
    } else if (focused && (event.key === 'Home' || event.key === 'End')) {
      event.preventDefault();
      // Week start/end, Monday-first: how far into the week the focused day sits.
      const { y, m, d } = parseIso(focused)!;
      const offset = (new Date(y, m - 1, d).getDay() + 6) % 7;
      moveFocused(event.key === 'Home' ? -offset : 6 - offset);
    } else if (event.key === 'PageUp' || event.key === 'PageDown') {
      event.preventDefault();
      shiftMonth(event.key === 'PageUp' ? -1 : 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeCalendar(true);
    }
  }

  // Focus moves in an effect, ARMED by the handlers: the button for a newly focused day may not
  // exist until its month renders.
  useEffect(() => {
    if (!open || !armGridRef.current || !focused) return;
    armGridRef.current = false;
    panelRef.current
      ?.querySelector<HTMLButtonElement>(`[data-iso="${CSS.escape(focused)}"]`)
      ?.focus();
  }, [open, focused, view]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        // An outside click has already moved focus where the pointer went; do not steal it back.
        setOpen(false);
        setAnchor(null);
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  /**
   * Blurring a field drops only ITS OWN draft, and only if it never became a real, selectable day —
   * a stray "2026-0" left behind should not linger to confuse the next edit. A VALID entry stays,
   * because it may still be waiting for its partner (see {@link editField}); it is cleared once the
   * pair actually commits, or by the explicit Clear button.
   */
  const dropDraft = (field: 'from' | 'to') => () => {
    setDraft((d) => {
      const text = d[field];
      if (text !== undefined && (!parseIso(text) || dayDisabled(text))) {
        const next = { ...d };
        delete next[field];
        return next;
      }
      return d;
    });
    setError(null);
  };

  // Normalised first: a chevron asked for month -1 or 12 has to land on the right December/January.
  const monthHasSelectable = (y: number, m: number) => {
    const first = new Date(y, m, 1);
    const prefix = toIso(first).slice(0, 7);
    return monthCells({ y: first.getFullYear(), m: first.getMonth() }).some(
      (iso) => iso.slice(0, 7) === prefix && !dayDisabled(iso),
    );
  };

  const cells = view ? monthCells(view) : [];

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <div className="flex items-center gap-1.5">
        <div className="relative flex-1">
          <CalendarDays
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-subtle"
            strokeWidth={1.75}
            aria-hidden="true"
          />
          <RangeField
            ref={fromRef}
            id={rootId}
            aria-label="From date"
            value={draft.from ?? shown?.from ?? ''}
            aria-describedby={error?.field === 'from' ? errorId : undefined}
            disabled={disabled}
            invalid={error?.field === 'from'}
            onEdit={(text) => editField('from', text)}
            onFocus={() => {
              // Handing focus BACK must not read as "open me" again — see returningFocusRef.
              if (returningFocusRef.current) returningFocusRef.current = false;
              else openCalendar('from');
            }}
            onBlur={dropDraft('from')}
            onKeyDown={(event) => onFieldKeyDown(event, 'from')}
          />
        </div>
        <span className="text-fg-subtle" aria-hidden="true">
          –
        </span>
        <RangeField
          id={`${rootId}-to`}
          aria-label="To date"
          ref={toRef}
          className="flex-1"
          value={draft.to ?? shown?.to ?? ''}
          aria-describedby={error?.field === 'to' ? errorId : undefined}
          disabled={disabled}
          invalid={error?.field === 'to'}
          onEdit={(text) => editField('to', text)}
          onFocus={() => {
            if (returningFocusRef.current) returningFocusRef.current = false;
            else openCalendar('to');
          }}
          onBlur={dropDraft('to')}
          onKeyDown={(event) => onFieldKeyDown(event, 'to')}
        />
        {shown && !disabled && (
          <button
            type="button"
            aria-label="Clear dates"
            onClick={() => {
              onChange(null);
              setAnchor(null);
              setDraft({});
              setError(null);
            }}
            className={cn(
              'rounded p-1 text-fg-subtle transition-colors hover:text-danger',
              FOCUS_RING,
            )}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <FieldError id={errorId} message={error?.message} />

      {open && view && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Choose date range"
          onKeyDown={onGridKeyDown}
          className="absolute left-0 z-20 mt-1 w-72 rounded-lg border border-border bg-surface p-3 shadow-lg"
        >
          <div className="mb-2 flex items-center justify-between">
            <MonthButton
              label="Previous month"
              blocked={!monthHasSelectable(view.y, view.m - 1)}
              onClick={() => shiftMonth(-1)}
            >
              <ChevronLeft className="h-4 w-4" strokeWidth={1.75} />
            </MonthButton>
            <div id={titleId} aria-live="polite" className="text-sm font-medium text-fg">
              {MONTHS[view.m]} {view.y}
            </div>
            <MonthButton
              label="Next month"
              blocked={!monthHasSelectable(view.y, view.m + 1)}
              onClick={() => shiftMonth(1)}
            >
              <ChevronRight className="h-4 w-4" strokeWidth={1.75} />
            </MonthButton>
          </div>

          <div role="grid" aria-labelledby={titleId}>
            <div role="row">
              {WEEKDAYS.map((weekday) => (
                <div
                  key={weekday}
                  role="columnheader"
                  className="inline-block w-9 text-center text-2xs font-medium uppercase text-fg-subtle"
                >
                  {weekday}
                </div>
              ))}
            </div>
            {Array.from({ length: 6 }, (_, week) => (
              <div role="row" key={cells[week * 7]}>
                {cells.slice(week * 7, week * 7 + 7).map((iso) => {
                  const selected = !!shown && (iso === shown.from || iso === shown.to);
                  // An in-between day is part of the window but is not itself "selected".
                  const inRange =
                    !!shown && iso > shown.from && iso < shown.to && !dayDisabled(iso);
                  const outside = Number(iso.slice(5, 7)) - 1 !== view.m;
                  return (
                    <div role="gridcell" key={iso} className="inline-block w-9">
                      <button
                        type="button"
                        data-iso={iso}
                        disabled={dayDisabled(iso)}
                        tabIndex={iso === focused ? 0 : -1}
                        aria-selected={selected || undefined}
                        aria-current={iso === today ? 'date' : undefined}
                        aria-label={dayName(iso)}
                        onClick={() => pickDay(iso)}
                        className={cn(
                          'h-8 w-9 rounded-md text-xs transition-colors',
                          FOCUS_RING,
                          selected
                            ? 'bg-accent font-medium text-accent-fg'
                            : inRange
                              ? 'bg-accent-muted text-accent-muted-fg'
                              : 'text-fg hover:bg-surface-hover',
                          outside && !selected && 'text-fg-subtle',
                          dayDisabled(iso) && 'cursor-not-allowed opacity-40 hover:bg-transparent',
                        )}
                      >
                        {Number(iso.slice(8))}
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
