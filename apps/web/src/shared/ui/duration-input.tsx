/**
 * DurationInput — a length of time, held in MINUTES and shown as hours + minutes.
 *
 * WHY MINUTES UNDERNEATH. Every duration in the API is minutes, and a control that accepted "1.5"
 * or "90" beside a free-text unit would hand the caller three shapes to normalise. This emits one
 * number, always; the split is presentation.
 *
 * WHY SPLIT FIELDS, NOT ONE "8h 30m" BOX. Free text makes the component a parser, and a parser has
 * to guess: "8", "8h", "8 hours", "8h30" are all legal and all different to read back. Two numeric
 * fields feel like a clock, validate per unit, and put the error beside the digit that caused it.
 * An empty field IS zero — clearing hours means "no hours", which is not a mistake to scold.
 *
 * INVALID TYPING IS HELD, NOT CLAMPED — the one behaviour to know before consuming this. What the
 * user typed stays in the field (local draft) while it is invalid, the offending field is flagged
 * `aria-invalid`, and a `role="alert"` line says why; `onChange` does not fire until the pair parses
 * and sits inside `min`/`max`. A control that silently rewrites "90" minutes into "1" hour while
 * somebody is typing teaches them the field lies, and they correct the wrong half. On blur the
 * draft is dropped and the fields show the controlled `value` again.
 *
 * Field styling is the exact string `Input` renders — the same call `Select` made ("styled to match
 * `Input`"), for the same reason: three controls drifting into three error treatments is how a form
 * ends up with two ideas of what "wrong" looks like.
 */
import { useId, useState } from 'react';
import { cn } from '@/shared/lib/utils';
import { formatDuration } from '@/shared/lib/format';
import { FOCUS_RING } from './button';
import { FieldError } from './form-field';

/** A shortcut button, e.g. `{ label: '8h', minutes: 480 }`. */
export interface DurationPreset {
  label: string;
  minutes: number;
}

export interface DurationInputProps {
  /** The duration in MINUTES. `onChange` never fires with anything else. */
  value: number;
  onChange: (minutes: number) => void;
  /** Shortcut buttons under the fields; the preset matching `value` is `aria-pressed`. */
  presets?: DurationPreset[];
  /** Inclusive floor, in minutes. Below it the value is held and explained, not clamped. */
  min?: number;
  /** Inclusive ceiling, in minutes. */
  max?: number;
  /** On the hours field; minutes gets `${id}-minutes`. Points a `FormField` label at hours. */
  id?: string;
  /**
   * The group's name, for the fields and the preset row: "Estimated effort" reads as
   * "Estimated effort, hours". Defaults to "Duration".
   */
  ariaLabel?: string;
  disabled?: boolean;
  /** An error the caller knows and this cannot (a form-level rule). Shown instead of the built-ins. */
  error?: string;
  className?: string;
}

const digit = (text: string): number | null => {
  if (text === '') return 0; // An empty unit is zero — see the docblock.
  return /^\d+$/.test(text) ? Number(text) : null;
};

export function DurationInput({
  value,
  onChange,
  presets,
  min,
  max,
  id,
  ariaLabel,
  disabled = false,
  error,
  className,
}: DurationInputProps) {
  const generatedId = useId();
  const rootId = id ?? generatedId;
  const hoursId = rootId;
  const minutesId = `${rootId}-minutes`;
  const errorId = `${rootId}-error`;
  const groupLabel = ariaLabel ?? 'Duration';

  const [draft, setDraft] = useState<{ h: string; m: string } | null>(null);

  const hoursText = draft?.h ?? String(Math.floor(value / 60));
  const minutesText = draft?.m ?? String(value % 60);

  // ── Validation ───────────────────────────────────────────────────────────────
  const hours = digit(hoursText);
  const minutes = digit(minutesText);
  const total = hours !== null && minutes !== null ? hours * 60 + minutes : null;

  let internalError: string | null = null;
  let flagHours = false;
  let flagMinutes = false;
  if (hours === null) {
    internalError = 'Hours must be a whole number of 0 or more.';
    flagHours = true;
  } else if (minutes === null || minutes > 59) {
    internalError = 'Minutes must be a whole number between 0 and 59.';
    flagMinutes = true;
  } else if (total !== null && min !== undefined && total < min) {
    internalError = `Duration must be at least ${formatDuration(min)}.`;
  } else if (total !== null && max !== undefined && total > max) {
    internalError = `Duration must be at most ${formatDuration(max)}.`;
  }
  const message = error ?? internalError;
  // A range or caller-level error is about the total, which both fields produce together.
  const invalidHours = flagHours || (!flagMinutes && !!message);
  const invalidMinutes = flagMinutes || (!flagHours && !!message);

  function edit(field: 'h' | 'm', text: string) {
    const next = { h: field === 'h' ? text : hoursText, m: field === 'm' ? text : minutesText };
    setDraft(next);
    const h = digit(next.h);
    const m = digit(next.m);
    if (h === null || m === null || m > 59) return; // Held locally; the alert line explains.
    const minutesTotal = h * 60 + m;
    if (min !== undefined && minutesTotal < min) return;
    if (max !== undefined && minutesTotal > max) return;
    onChange(minutesTotal);
  }

  const fieldClass = (invalid: boolean) =>
    cn(
      'h-9 w-14 rounded-md border bg-surface text-center text-sm text-fg transition-colors focus:outline-none focus:ring-2 disabled:cursor-not-allowed disabled:opacity-50',
      invalid
        ? 'border-red-400 focus:border-red-400 focus:ring-red-400/20 dark:border-red-500'
        : 'border-border focus:border-accent focus:ring-accent/20',
    );

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div role="group" aria-label={groupLabel} className="flex items-center gap-1.5">
        <input
          id={hoursId}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          aria-label={`${groupLabel}, hours`}
          aria-invalid={invalidHours ? 'true' : undefined}
          aria-describedby={message ? errorId : undefined}
          disabled={disabled}
          value={hoursText}
          onChange={(e) => edit('h', e.target.value)}
          onBlur={() => setDraft(null)}
          className={fieldClass(invalidHours)}
        />
        <span className="text-xs text-fg-subtle" aria-hidden="true">
          h
        </span>
        <input
          id={minutesId}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          aria-label={`${groupLabel}, minutes`}
          aria-invalid={invalidMinutes ? 'true' : undefined}
          aria-describedby={message ? errorId : undefined}
          disabled={disabled}
          value={minutesText}
          onChange={(e) => edit('m', e.target.value)}
          onBlur={() => setDraft(null)}
          className={fieldClass(invalidMinutes)}
        />
        <span className="text-xs text-fg-subtle" aria-hidden="true">
          m
        </span>
      </div>

      {presets && presets.length > 0 && (
        <div role="group" aria-label={`${groupLabel} presets`} className="flex flex-wrap gap-1">
          {presets.map((preset) => {
            const pressed = value === preset.minutes;
            return (
              <button
                key={preset.label}
                type="button"
                aria-pressed={pressed}
                disabled={disabled}
                onClick={() => {
                  setDraft(null);
                  onChange(preset.minutes);
                }}
                className={cn(
                  'rounded-md border px-2 py-1 text-xs font-medium transition-colors',
                  FOCUS_RING,
                  pressed
                    ? 'border-accent bg-accent-muted text-accent-muted-fg'
                    : 'border-border text-fg-muted hover:bg-surface-hover hover:text-fg',
                  disabled && 'cursor-not-allowed opacity-50',
                )}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
      )}

      <FieldError id={errorId} message={message ?? undefined} />
    </div>
  );
}
