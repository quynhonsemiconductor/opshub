import type { HTMLAttributes } from 'react';
import { cn } from '@/shared/lib/utils';

/** Token-backed tones — flip automatically in dark mode via globals.css. */
const tones = {
  neutral: 'bg-neutral-bg text-neutral-fg',
  green: 'bg-success-bg text-success',
  amber: 'bg-warning-bg text-warning',
  red: 'bg-danger-bg text-danger',
  blue: 'bg-info-bg text-info',
  violet: 'bg-violet-bg text-violet-fg',
} as const;

export type BadgeTone = keyof typeof tones;

export interface BadgeProps extends Omit<HTMLAttributes<HTMLElement>, 'onClick'> {
  tone?: BadgeTone;
  /**
   * Makes the badge a real `<button>` instead of a label — for a badge that IS a route.
   *
   * WHY THIS BELONGS ON THE PRIMITIVE. A red badge is often the loudest finding on a screen and the
   * only thing that names the gap: the supplier register's "No DPA" says a processor has no data
   * processing agreement, which is a GDPR Article 28(3) problem with a specific fix. Making the
   * finding itself the way to that fix is the shortest possible route, and doing it at each call site
   * means a hand-rolled `<button>` wrapper per page, each having to remember `type="button"`, a focus
   * ring, and the `stopPropagation` below.
   *
   * `stopPropagation` IS INCLUDED, not left to the caller: an interactive badge lives in a table cell,
   * and a `DataTable` row is itself clickable, so without it acting on the finding ALSO opens the
   * detail drawer over the form that was just opened. Same reasoning as `RowActions`, which does it
   * once for the actions column.
   *
   * Absent means a span, which is what a badge that only reports a state should be — a control whose
   * only outcome is a refusal is worse than no control, so a caller with nothing to offer omits it.
   */
  onClick?: () => void;
}

export function Badge({ className, tone = 'neutral', onClick, ...props }: BadgeProps) {
  const classes = cn(
    'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium',
    tones[tone],
    // Dotted underline rather than a border: it reads as "there is more here" at badge size without
    // changing the badge's footprint, so an interactive one still lines up with a static one beside it.
    onClick &&
      'cursor-pointer underline decoration-dotted underline-offset-2 transition-opacity hover:opacity-80 ' +
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
    className,
  );

  if (onClick) {
    return (
      <button
        type="button"
        className={classes}
        onClick={(event) => {
          event.stopPropagation();
          onClick();
        }}
        {...props}
      />
    );
  }

  return <span className={classes} {...props} />;
}
