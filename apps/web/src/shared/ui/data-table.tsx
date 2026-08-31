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
 *   * NO SELECTION STATE OF ITS OWN. Bulk selection is opt-in (`selectedIds` / `onSelectionChange`)
 *     and the caller owns the set; see the prop comment for the page-scoped semantics.
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
  /**
   * Opt-in bulk selection. Pass `onSelectionChange` and a leading checkbox column appears; the
   * twenty-plus pages that pass neither see no checkbox and no extra column. Row identity is the
   * component's own — the same `rowKey` (default `row.id`) that keys the rows.
   *
   * PAGE-SCOPED, AND STATE THE CALLER OWNS. The table is stateless about selection: `selectedIds`
   * in, a fresh array out. Selections therefore survive a page change BY CONSTRUCTION — the pager
   * swaps `rows`, the component re-renders, and ids the page still holds stay selected even for
   * rows no longer rendered. Nothing clears them, because nothing in this component knows what a
   * page transition means to the caller's query.
   *
   * "Select all" is deliberately scoped to the CURRENT page: it never reaches for rows the user
   * has not been shown. A header checkbox that silently commits decisions about unseen rows is how
   * "delete 400 records" accidents happen; bulk-everything is the caller's explicit action, not a
   * checkbox's side effect.
   */
  selectedIds?: Set<string> | string[];
  /**
   * Fired with the COMPLETE next selection and its size — the whole array, not a delta, so the
   * caller's state update is a plain replacement. `selectedCount` rides along so a bulk bar can
   * label itself ("3 selected") without re-deriving it. Ids come back deterministically: current
   * page in row order first, then other pages' ids in the order the caller last held them.
   */
  onSelectionChange?: (selectedIds: string[], selectedCount: number) => void;
  /**
   * Rendered in a slim bar above the table while the selection is non-empty, and hidden the
   * moment it is empty again. Receives the count for its label.
   */
  bulkActions?: (selectedCount: number) => ReactNode;
}

const HEADER_CELL = 'px-4 py-2.5 text-xs font-medium tracking-wide text-fg-muted whitespace-nowrap';
const BODY_CELL = 'px-4 py-2.5 text-sm text-fg';
// Checkbox's native input, verbatim. A table whose checkboxes render with a different box, border
// or focus ring than the forms beside it is drift, not variety — same tokens, no import needed,
// because a bare input in a cell has no label to wrap.
const SELECT_CHECKBOX =
  'h-4 w-4 cursor-pointer rounded border-border-strong text-accent focus:ring-accent';

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
  selectedIds,
  onSelectionChange,
  bulkActions,
}: DataTableProps<Row>) {
  const keyOf = rowKey ?? ((row: Row) => String((row as { id?: unknown }).id));

  // Selection is ON only when the caller passed the callback — `selectedIds` alone is inert, so a
  // half-wired call site cannot render a column that does nothing. The checkbox column is real
  // width, so the state rows must span it too.
  const selectable = onSelectionChange !== undefined;
  const selectedSet = new Set(selectedIds ?? []);
  const pageIds = selectable ? (rows ?? []).map(keyOf) : [];
  const selectedOnPage = pageIds.filter((id) => selectedSet.has(id)).length;
  const allPageSelected = pageIds.length > 0 && selectedOnPage === pageIds.length;
  const somePageSelected = selectedOnPage > 0 && !allPageSelected;
  const selectedCount = selectedSet.size;

  const toggleRow = (id: string) => {
    if (!onSelectionChange) return;
    const next = new Set(selectedSet);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectionChange([...next], next.size);
  };

  // Current page only, per the contract above — ids on OTHER pages are left exactly as they were.
  // Emitted deterministically: current page in row order, then any other pages' ids in the order
  // the caller last held them, so a payload never depends on Set insertion accidents.
  const toggleAllOnPage = () => {
    if (!onSelectionChange || pageIds.length === 0) return;
    const selectPage = !allPageSelected;
    const pageIdSet = new Set(pageIds);
    const next: string[] = [];
    if (selectPage) for (const id of pageIds) next.push(id);
    for (const id of selectedSet) {
      if (!pageIdSet.has(id)) next.push(id);
    }
    onSelectionChange(next, next.length);
  };

  // Derived, never passed in: a hard-coded colSpan is what silently broke alignment every time
  // somebody added a column.
  const span = columns.length + (selectable ? 1 : 0);

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-surface">
      {selectable && selectedCount > 0 && bulkActions !== undefined && (
        /*
         * The toolbar this table never had, and deliberately not a permanent one: an action bar
         * sitting empty above every table is furniture asking to be ignored. It exists only while
         * the selection does, and the count is the caller's to phrase — the table knows how many,
         * not what they are.
         */
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-muted px-4 py-2">
          {bulkActions(selectedCount)}
        </div>
      )}
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-surface-muted">
            {selectable && (
              <th scope="col" className="px-4 py-2.5">
                {/* Native input, so Space toggles it and the indeterminate property carries the
                    "some, not all" semantics no checked boolean can express. */}
                <input
                  type="checkbox"
                  aria-label="Select all on page"
                  checked={allPageSelected}
                  disabled={pageIds.length === 0}
                  onChange={toggleAllOnPage}
                  ref={(el) => {
                    if (el) el.indeterminate = somePageSelected;
                  }}
                  className={SELECT_CHECKBOX}
                />
              </th>
            )}
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
                  {selectable && (
                    <td className="px-4 py-2.5 align-middle">
                      {/*
                       * The checkbox is a control in the row, not the row itself — the same
                       * reasoning that keeps the actions column's buttons from announcing the whole
                       * row as their name. Click and key events stop here: without this, Space on a
                       * focused checkbox toggles it AND activates the row beneath it, and one
                       * keypress does two things at once.
                       */}
                      <input
                        type="checkbox"
                        aria-label="Select row"
                        checked={selectedSet.has(keyOf(row))}
                        onChange={() => toggleRow(keyOf(row))}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                        className={SELECT_CHECKBOX}
                      />
                    </td>
                  )}
                </tr>
              );
            })}
        </tbody>
      </table>
    </div>
  );
}
