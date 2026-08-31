import type { ComponentType, ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowRight } from 'lucide-react';
import { StatCard, type BadgeTone } from '@/shared/ui';
import { cn } from '@/shared/lib/utils';

export type DashboardIcon = ComponentType<{ className?: string; strokeWidth?: number }>;

/**
 * A stat tile that navigates.
 *
 * The tile itself is the shared `StatCard` — this only adds the link and the arrow. The version it
 * replaces was a 50-line component with its own border, its own skeleton and its own `ACCENT` map of
 * RAW palette classes (`bg-blue-50 text-blue-600 dark:bg-blue-500/15 …`), hand-writing the dark
 * variants that the semantic tokens exist to supply. Six tones, twelve colour decisions, none of them
 * shared with the four other screens that also show stat tiles.
 */
export function StatTileLink({
  to,
  label,
  value,
  hint,
  loading,
  icon,
  tone,
  alert,
}: {
  to: string;
  label: string;
  value: number | string | undefined;
  /** The line under the figure — a denominator, or why the figure is missing. */
  hint?: string;
  loading?: boolean;
  icon: DashboardIcon;
  tone: BadgeTone;
  alert?: boolean;
}) {
  return (
    <Link to={to} className="group block transition-shadow hover:shadow-md">
      <StatCard
        label={label}
        value={value}
        hint={hint}
        loading={loading}
        icon={icon}
        tone={tone}
        alert={alert}
        trailing={
          <ArrowRight
            className="h-4 w-4 shrink-0 text-fg-subtle transition-colors group-hover:text-fg-muted"
            strokeWidth={1.75}
            aria-hidden="true"
          />
        }
      />
    </Link>
  );
}

/** A titled panel holding a list of `DomainLink`s. */
export function SectionCard({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: DashboardIcon;
  children: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface shadow-sm">
      <div className="flex items-center gap-2 border-b border-border px-5 py-3.5">
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-accent-secondary-muted text-accent-secondary-muted-fg">
          <Icon className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
        </div>
        <span className="text-sm font-medium text-fg">{title}</span>
      </div>
      <div className="divide-y divide-border">{children}</div>
    </div>
  );
}

/** Tone → icon tint, from the tokens rather than from a palette. */
const ICON_TONE: Record<BadgeTone, string> = {
  neutral: 'bg-neutral-bg text-neutral-fg',
  green: 'bg-success-bg text-success',
  amber: 'bg-warning-bg text-warning',
  red: 'bg-danger-bg text-danger',
  blue: 'bg-info-bg text-info',
  violet: 'bg-violet-bg text-violet-fg',
};

/** One row inside a `SectionCard`: where it goes and why you would. */
export function DomainLink({
  label,
  sub,
  to,
  icon: Icon,
  tone,
}: {
  label: string;
  sub: string;
  to: string;
  icon: DashboardIcon;
  tone: BadgeTone;
}) {
  return (
    <Link
      to={to}
      className="group flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-surface-hover"
    >
      <div
        className={cn(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-md',
          ICON_TONE[tone],
        )}
      >
        <Icon className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-fg">{label}</div>
        <div className="text-xs text-fg-subtle">{sub}</div>
      </div>
      <ArrowRight
        className="h-3.5 w-3.5 shrink-0 text-fg-subtle transition-colors group-hover:text-fg-muted"
        strokeWidth={1.75}
        aria-hidden="true"
      />
    </Link>
  );
}
