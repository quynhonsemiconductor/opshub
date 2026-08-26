/**
 * DataTable — the one table in the SPA.
 *
 * WHY THIS EXISTS
 * ---------------
 * Nine pages hand-rolled the same `<table>`: the same sticky header classes, the same
 * `colSpan` loading row, the same error row, the same centred empty state with an icon. The
 * header cell classes alone appeared 72 times. That is the kind of duplication that looks
 * harmless until one copy diverges — and several already had: some tables showed an empty
 * state and some rendered nothing, some coloured the error row and some did not, and the
 * `colSpan` was hard-coded per table so adding a column silently broke the alignment of every
 * state row beneath it.
 *
 * So the states are the component's job, not each page's. A page declares COLUMNS and ROWS and
 * gets loading, error, empty and the correct `colSpan` for free.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 *   * NO DATA FETCHING. It takes `rows`, `isLoading` and `isError` — the query stays in the
 *     page, where the cache key and the invalidation live. A table that fetched would need to
 *     know about every endpoint's shape.
 *   * NO PAGINATION. Every list endpoint in OpsHub pages SERVER-SIDE (`limit`/`offset` in,
 *     `pageInfo` back), so a table slicing its own rows would show page 1 of page 1. See
 *     `PaginationFooter` and `useListState`.
 *   * NO SORTING. Ordering is the API's — every list route has a total order (see
 *     `test/query-ordering.ratchet.spec.ts`), and a client-side sort over one page of rows
 *     would reorder that page only, which reads as a bug.
 */
import type { ComponentType, ReactNode } from 'react';
import { Inbox } from 'lucide-react';

export interface DataTableColumn<Row> {
  /** Stable key — also the React key for the cell. */
  key: string;
  header: ReactNode;
  /** The cell. Given the whole row, so a column can combine fields. */
  cell: (row: Row) => ReactNode;
  /** Right-aligned for numbers, so columns of figures line up on their units. */
  align?: 'left' | 'right';
  /** Extra classes for the cell — width hints, `whitespace-nowrap`, truncation. */
  className?: string;
  /** Hide below `sm`. For the column a phone can do without rather than squeeze. */
  hideOnMobile?: boolean;
}

export interface DataTableProps<Row> {
  columns: DataTableColumn<Row>[];
  rows: Row[] | undefined;
  /** Stable identity per row. Defaults to `row.id` when present. */
  rowKey?: (row: Row) => string;
  isLoading?: boolean;
  isError?: boolean;
  /** What the error row says. Named for the resource so it is useful in a screenshot. */
  errorMessage?: string;
  /** What the empty state says. */
  emptyMessage?: string;
  emptyIcon?: ComponentType<{ className?: string; strokeWidth?: number }>;
  /** Rendered under the empty message — usually the "create the first one" button. */
  emptyAction?: ReactNode;
  /**
   * Makes rows clickable, focusable, and operable with Enter/Space — a clickable row that only
   * answers a mouse is unusable for anybody who does not use one.
   *
   * The row does NOT take `role="button"`. It did, and that was wrong twice over: a button's
   * accessible name is computed from its contents, so the row announced every cell's text run
   * together — including the labels of the buttons inside it — and `getByRole('button', { name })`
   * then matched both the row and its own delete control. A row stays a row; the click is a
   * shortcut, and the actions column holds the controls that are meant to be found by name.
   */
  onRowClick?: (row: Row) => void;
  /** Marks a row as the selected one, e.g. while its detail panel is open. */
  isRowActive?: (row: Row) => boolean;
}

const HEADER_CELL = 'px-4 py-2.5 text-xs font-medium tracking-wide text-fg-muted whitespace-nowrap';
const BODY_CELL = 'px-4 py-2.5 text-sm text-fg';

function align(a: DataTableColumn<unknown>['align']): string {
  return a === 'right' ? 'text-right' : 'text-left';
}

export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  isLoading = false,
  isError = false,
  errorMessage = 'Failed to load.',
  emptyMessage = 'Nothing here yet',
  emptyIcon: EmptyIcon = Inbox,
  emptyAction,
  onRowClick,
  isRowActive,
}: DataTableProps<Row>) {
  const keyOf = rowKey ?? ((row: Row) => String((row as { id?: unknown }).id));
  // Derived, never passed in: a hard-coded colSpan is what silently broke alignment every time
  // somebody added a column.
  const span = columns.length;

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-surface">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-surface-muted">
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={[
                  HEADER_CELL,
                  align(c.align),
                  c.hideOnMobile ? 'hidden sm:table-cell' : '',
                  c.className ?? '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {isLoading && (
            <tr>
              <td colSpan={span} className="px-4 py-8 text-center text-sm text-fg-subtle">
                Loading…
              </td>
            </tr>
          )}

          {/* Error BEFORE empty: a failed request has no rows either, and "nothing here yet" is a
              lie about a list nobody managed to read. */}
          {!isLoading && isError && (
            <tr>
              <td colSpan={span} className="px-4 py-8 text-center text-sm text-danger">
                {errorMessage}
              </td>
            </tr>
          )}

          {!isLoading && !isError && rows?.length === 0 && (
            <tr>
              <td colSpan={span} className="px-4 py-12 text-center">
                <div className="flex flex-col items-center gap-2">
                  <EmptyIcon className="h-8 w-8 text-fg-subtle" strokeWidth={1.5} />
                  <span className="text-sm text-fg-subtle">{emptyMessage}</span>
                  {emptyAction}
                </div>
              </td>
            </tr>
          )}

          {!isLoading &&
            !isError &&
            rows?.map((row) => {
              const clickable = onRowClick !== undefined;
              return (
                <tr
                  key={keyOf(row)}
                  /*
                   * THE ROW'S IDENTITY, in the DOM.
                   *
                   * `keyOf` already computes a stable per-row key for React; exposing it costs nothing
                   * at runtime and gives a test a handle that does not depend on what the row happens
                   * to display. That matters here specifically: request ids are uuid v7, so the first
                   * eight characters are a TIMESTAMP and several rows share them — which is why the
                   * inbox row shows the requester's name instead, and why the spec that needed a
                   * particular request had fallen back to "click the first row" and to an assumption
                   * about ordering that another write can break.
                   */
                  data-row-id={keyOf(row)}
                  // A row is only focusable when it actually does something.
                  {...(clickable
                    ? {
                        tabIndex: 0,
                        onClick: () => onRowClick(row),
                        onKeyDown: (e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onRowClick(row);
                          }
                        },
                      }
                    : {})}
                  className={[
                    clickable ? 'cursor-pointer hover:bg-surface-muted' : '',
                    isRowActive?.(row) ? 'bg-accent-muted' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={[
                        BODY_CELL,
                        align(c.align),
                        c.hideOnMobile ? 'hidden sm:table-cell' : '',
                        c.className ?? '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      {c.cell(row)}
                    </td>
                  ))}
                </tr>
              );
            })}
        </tbody>
      </table>
    </div>
  );
}
