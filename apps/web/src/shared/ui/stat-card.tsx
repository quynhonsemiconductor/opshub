import type { ComponentType, ReactNode } from 'react';
import { cn } from '@/shared/lib/utils';
import type { BadgeTone } from './badge';
import { orDash } from '@/shared/lib/format';

/** Icon tint per tone. Tokens, not palette values, so the card flips with the theme. */
const ICON_TONE: Record<BadgeTone, string> = {
  neutral: 'bg-neutral-bg text-neutral-fg',
  green: 'bg-success-bg text-success',
  amber: 'bg-warning-bg text-warning',
  red: 'bg-danger-bg text-danger',
  blue: 'bg-info-bg text-info',
  violet: 'bg-violet-bg text-violet-fg',
};

export interface StatCardProps {
  label: string;
  value: ReactNode;
  /** A denominator, a delta, a date — the line under the figure. */
  hint?: ReactNode;
  icon?: ComponentType<{ className?: string; strokeWidth?: number }>;
  tone?: BadgeTone;
  /** Shows a skeleton in place of the figure. The label stays, so the tile does not jump. */
  loading?: boolean;
  /**
   * Draw attention: a red ring and a red figure.
   *
   * For a count that means somebody has to act — "3 awaiting my approval". Deliberately ignored when
   * the value is 0 or absent, because a red ring around a zero is an alarm about nothing, and the
   * dashboard had exactly that until the caller started passing this instead of its own `variant`.
   */
  alert?: boolean;
  /** Slotted after the figure — a link arrow, a trend chip. */
  trailing?: ReactNode;
  className?: string;
}

/**
 * StatCard — the KPI tile at the top of a screen.
 *
 * Eleven copies across four pages (people, catalog, finops, security posture), each with its own
 * padding, its own icon treatment and — in three of them — a `color` prop taking a raw Tailwind pair
 * like `bg-blue-50 text-blue-600`. Those do not flip in dark mode, which is the whole reason this
 * codebase has semantic tokens, so the tiles were legible on one theme and washed out on the other.
 *
 * Takes a TONE rather than a class string, exactly as `Badge` does: the card decides what a tone
 * looks like, the page decides what it means.
 */
export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = 'neutral',
  loading = false,
  alert = false,
  trailing,
  className,
}: StatCardProps) {
  // A zero is not an alarm. `value` is a ReactNode, so the check is on the number case only.
  const alarming = alert && typeof value === 'number' && value > 0;

  return (
    <div
      className={cn(
        'rounded-xl border bg-surface p-4 shadow-sm',
        alarming ? 'border-danger/40 ring-1 ring-danger/15' : 'border-border',
        className,
      )}
    >
      <div className="flex items-start gap-3">
        {Icon && (
          <div className={cn('rounded-lg p-2', alarming ? ICON_TONE.red : ICON_TONE[tone])}>
            <Icon className="h-4 w-4" strokeWidth={2} />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-xs text-fg-subtle">{label}</p>
          <p
            className={cn(
              'mt-0.5 text-xl font-semibold tabular-nums',
              alarming ? 'text-danger' : 'text-fg',
            )}
          >
            {loading ? (
              <span className="inline-block h-6 w-8 animate-pulse rounded bg-surface-hover" />
            ) : (
              orDash(value)
            )}
          </p>
          {hint && <p className="mt-0.5 text-xs text-fg-muted">{hint}</p>}
        </div>
        {trailing}
      </div>
    </div>
  );
}

export interface StatGridProps {
  children: ReactNode;
  className?: string;
}

/** The responsive row those tiles sit in — one breakpoint set, not four different ones. */
export function StatGrid({ children, className }: StatGridProps) {
  return (
    <div className={cn('grid gap-3 sm:grid-cols-2 lg:grid-cols-4', className)}>{children}</div>
  );
}
