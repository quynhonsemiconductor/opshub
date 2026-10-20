/**
 * ListPage — the one layout for an entity list screen.
 *
 * WHY THIS EXISTS
 * ---------------
 * The nine list screens in OpsHub each re-wired the same four things in their own order: a title
 * block, a search box, a table and a row count. They drifted exactly as you would expect — some
 * had a search, some had filters above the table and some below, one showed the count on the left
 * and the rest on the right, and NONE of them paginated (every page requests `limit: 100` and
 * shows a total, so any list with more than a hundred rows silently truncates).
 *
 * This composes the pieces in ONE order and owns nothing else:
 *
 *   PageHeader        — title, description, primary action
 *   toolbar           — search · filters · trailing slot
 *   DataTable         — supplied by the page, with its own columns
 *   PaginationFooter  — "26–50 of 312", from the API's `pageInfo`
 *
 * STATE LIVES IN `useListState`, NOT HERE. The search term and the offset have to be readable by
 * the page's query — that is the whole point of them — so a scaffold holding them privately would
 * force every page to lift them back out. It also means the reset-on-search rule lives in one
 * testable hook rather than in a component tree.
 *
 * NOT A COPY OF ROVA'S `ListPageScaffold`, deliberately. That one paginates CLIENT-side over a
 * fully-loaded array and owns row selection for bulk actions, because Rova's endpoints return
 * whole collections. Every OpsHub list endpoint pages server-side and none has a bulk operation
 * yet, so importing that design would mean a pager that lies about page 1 of 1 and a selection
 * gutter with nothing to do.
 */
import type { ReactNode } from 'react';
import { Search } from 'lucide-react';
import { PageHeader } from './page-header';
import { PaginationFooter, type PageInfo } from './pagination-footer';

export interface ListPageProps {
  title: string;
  description?: string;
  /** Primary action, top right — usually "+ New …". */
  actions?: ReactNode;
  /** Bound to `useListState`. Omit for a list with nothing worth searching. */
  search?: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
  };
  /**
   * Filter controls, shown beside the search.
   *
   * Always visible rather than behind a "Show filters" toggle: OpsHub lists have one or two
   * filters, and hiding two selects behind a disclosure costs a click to discover that there was
   * nothing to discover.
   */
  filters?: ReactNode;
  /** Pushed to the far right of the toolbar — a legend, an export, a secondary action. */
  trailing?: ReactNode;
  /** The `<DataTable>`, or tabs containing one. */
  children: ReactNode;
  /** From the API response. Omitted for an unpaged list. */
  pageInfo?: PageInfo;
  onOffsetChange?: (offset: number) => void;
  /** Counted noun for the footer: "employees", "findings". */
  noun?: string;
}

export function ListPage({
  title,
  description,
  actions,
  search,
  filters,
  trailing,
  children,
  pageInfo,
  onOffsetChange,
  noun,
}: ListPageProps) {
  const hasToolbar = Boolean(search || filters || trailing);

  return (
    <div className="space-y-4">
      <PageHeader title={title} description={description} actions={actions} />

      {hasToolbar && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          {search && (
            <div className="relative w-full sm:max-w-xs">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle"
                strokeWidth={1.75}
                aria-hidden="true"
              />
              <input
                type="search"
                value={search.value}
                onChange={(e) => search.onChange(e.target.value)}
                placeholder={search.placeholder ?? 'Search…'}
                // A label, not just a placeholder: the placeholder disappears the moment somebody
                // types, which leaves a screen reader with an unlabelled box.
                aria-label={search.placeholder ?? `Search ${title.toLowerCase()}`}
                className="h-9 w-full rounded-md border border-border bg-surface pl-8 pr-3 text-sm text-fg placeholder:text-fg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              />
            </div>
          )}
          {filters && <div className="flex flex-wrap items-center gap-2">{filters}</div>}
          {trailing && <div className="flex items-center gap-2 sm:ml-auto">{trailing}</div>}
        </div>
      )}

      {children}

      {onOffsetChange && (
        <PaginationFooter pageInfo={pageInfo} onOffsetChange={onOffsetChange} noun={noun} />
      )}
    </div>
  );
}
