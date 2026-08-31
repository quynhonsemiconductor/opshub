import type { ReactNode } from 'react';
import { cn } from '@/shared/lib/utils';

export interface PageHeaderProps {
  title: string;
  description?: string;
  /** Right-aligned actions (primary button, status pill, etc.). */
  actions?: ReactNode;
  className?: string;
  /**
   * 'lg' (default) is the standard list/detail-page title — `text-lg`, one per route. 'display'
   * steps up to the `--text-display` token for the rare true home/landing title, e.g. the persona
   * dashboard's "Overview". Reserve it for that: every route rendering its title at 36px would
   * flatten the hierarchy this exists to create.
   */
  size?: 'lg' | 'display';
}

const TITLE_SIZE: Record<NonNullable<PageHeaderProps['size']>, string> = {
  lg: 'text-lg font-semibold tracking-tight text-fg',
  display: 'text-display font-semibold text-fg',
};

/** Standard page title block. Used at the top of every route. */
export function PageHeader({
  title,
  description,
  actions,
  className,
  size = 'lg',
}: PageHeaderProps) {
  return (
    <div className={cn('flex items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        <h1 className={TITLE_SIZE[size]}>{title}</h1>
        {description && <p className="mt-0.5 text-sm text-fg-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
