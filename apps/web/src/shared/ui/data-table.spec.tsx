// @vitest-environment jsdom
/**
 * DataTable — the four states, and the `colSpan` nobody was maintaining.
 *
 * These are the SPA's first component tests. They exist because the states are exactly what the
 * nine hand-rolled copies got wrong in different ways: one showed "no rows" on a failed request,
 * several had no empty state at all, and every one hard-coded `colSpan` so adding a column left the
 * loading row spanning the wrong width.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DataTable, type DataTableColumn } from './data-table';

interface Row {
  id: string;
  name: string;
  count: number;
}

const COLUMNS: DataTableColumn<Row>[] = [
  { key: 'name', header: 'Name', cell: (r) => r.name },
  { key: 'count', header: 'Count', cell: (r) => r.count, align: 'right' },
  { key: 'extra', header: 'Extra', cell: () => '—', hideOnMobile: true },
];

const ROWS: Row[] = [
  { id: 'a', name: 'Alpha', count: 1 },
  { id: 'b', name: 'Beta', count: 2 },
];

describe('DataTable', () => {
  it('renders a header per column and a cell per row', () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} />);

    expect(screen.getAllByRole('columnheader')).toHaveLength(3);
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    // Two data rows plus the header row.
    expect(screen.getAllByRole('row')).toHaveLength(3);
  });

  it('shows loading and NOTHING else', () => {
    render(<DataTable columns={COLUMNS} rows={undefined} isLoading />);

    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.queryByText('Nothing here yet')).not.toBeInTheDocument();
  });

  it('shows the ERROR, not the empty state, when the request failed', () => {
    // The distinction the hand-rolled copies got wrong: a failed request has no rows either, and
    // "nothing here yet" is a lie about a list nobody managed to read.
    render(
      <DataTable columns={COLUMNS} rows={[]} isError errorMessage="Failed to load positions." />,
    );

    expect(screen.getByText('Failed to load positions.')).toBeInTheDocument();
    expect(screen.queryByText('Nothing here yet')).not.toBeInTheDocument();
  });

  it('shows the empty state with its action only when the list is genuinely empty', () => {
    render(
      <DataTable
        columns={COLUMNS}
        rows={[]}
        emptyMessage="No positions yet"
        emptyAction={<button type="button">Create one</button>}
      />,
    );

    expect(screen.getByText('No positions yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create one' })).toBeInTheDocument();
  });

  it('spans every state row across ALL columns, derived rather than hard-coded', () => {
    const { container } = render(<DataTable columns={COLUMNS} rows={undefined} isLoading />);
    expect(container.querySelector('tbody td')?.getAttribute('colspan')).toBe('3');

    // The regression that matters: a fourth column must widen the state row with no other edit.
    cleanupAndRender(
      <DataTable
        columns={[...COLUMNS, { key: 'four', header: 'Four', cell: () => null }]}
        rows={undefined}
        isLoading
      />,
    );
    expect(document.querySelector('tbody td')?.getAttribute('colspan')).toBe('4');
  });

  it('makes rows clickable and focusable WITHOUT turning them into buttons', () => {
    // A `role="button"` row computes its accessible name from every cell, so it announces the whole
    // row as one run of text and collides with the buttons inside it — `getByRole('button', { name })`
    // matched both the row and its own delete control, which a Playwright run caught. A row stays a
    // row.
    const onRowClick = vi.fn();
    render(<DataTable columns={COLUMNS} rows={ROWS} onRowClick={onRowClick} />);

    expect(screen.queryAllByRole('button')).toHaveLength(0);
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute('tabindex', '0');

    rows[0].click();
    expect(onRowClick).toHaveBeenCalledWith(ROWS[0]);
  });

  it('activates a row from the KEYBOARD, on Enter and on Space', () => {
    // A clickable row that only answers a mouse is unusable for anybody who does not use one, and
    // this is the assertion that makes the claim true rather than aspirational — the handler was
    // the one uncovered branch in this file.
    const onRowClick = vi.fn();
    render(<DataTable columns={COLUMNS} rows={ROWS} onRowClick={onRowClick} />);
    const row = screen.getAllByRole('row')[2];

    fireEvent.keyDown(row, { key: 'Enter' });
    expect(onRowClick).toHaveBeenLastCalledWith(ROWS[1]);

    // Space too: a browser scrolls the page on Space, so the handler must both act and preventDefault.
    fireEvent.keyDown(row, { key: ' ' });
    expect(onRowClick).toHaveBeenCalledTimes(2);

    // …and ONLY those two. Tab must still move focus rather than open the row.
    fireEvent.keyDown(row, { key: 'Tab' });
    fireEvent.keyDown(row, { key: 'a' });
    expect(onRowClick).toHaveBeenCalledTimes(2);
  });

  it('marks the active row so an open detail panel has a visible anchor', () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} isRowActive={(r) => r.id === 'b'} />);
    const rows = screen.getAllByRole('row');
    // Row 0 is the header; the active class lands on the second data row.
    expect(rows[2].className).toContain('bg-accent-muted');
    expect(rows[1].className).not.toContain('bg-accent-muted');
  });

  it('leaves rows inert — no tab stop — when there is nothing to click', () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} />);
    for (const row of screen.getAllByRole('row').slice(1)) {
      expect(row).not.toHaveAttribute('tabindex');
    }
  });

  it('keys rows by a custom function when the row has no id', () => {
    // Proves the fallback is a DEFAULT and not the only option: several API rows are keyed on a
    // composite (a code, an employee + a year) rather than an `id`.
    interface Keyless {
      code: string;
    }
    const columns: DataTableColumn<Keyless>[] = [
      { key: 'code', header: 'Code', cell: (r) => r.code },
    ];
    render(
      <DataTable columns={columns} rows={[{ code: 'X' }, { code: 'Y' }]} rowKey={(r) => r.code} />,
    );
    expect(screen.getByText('X')).toBeInTheDocument();
    expect(screen.getByText('Y')).toBeInTheDocument();
  });
});

/*
 * SELECTION, the opt-in surface. Twenty-plus pages pass neither `selectedIds` nor
 * `onSelectionChange`, so the first test is the one that protects them: no props, no checkbox, no
 * extra column. Everything else here only runs when a caller wires it up.
 *
 * The identity in play is the component's own — `rowKey`, defaulting to `row.id` — which is why the
 * row handles below go through `data-row-id` rather than assuming an `id` field.
 */
describe('DataTable selection', () => {
  interface SelectionRow {
    id: string;
    name: string;
  }
  const SELECT_COLUMNS: DataTableColumn<SelectionRow>[] = [
    { key: 'name', header: 'Name', cell: (r) => r.name },
  ];
  const PAGE_A: SelectionRow[] = [
    { id: 'a', name: 'Alpha' },
    { id: 'b', name: 'Beta' },
  ];
  /** Page B exists only to prove "current page" means something. */
  const PAGE_B: SelectionRow[] = [
    { id: 'c', name: 'Gamma' },
    { id: 'd', name: 'Delta' },
  ];

  const rowInput = (id: string): HTMLInputElement =>
    document.querySelector(`tr[data-row-id="${id}"] input`) as HTMLInputElement;

  it('renders NO checkbox column unless the selection props are passed', () => {
    // The backward-compat guard: every existing page renders through this line.
    render(<DataTable columns={SELECT_COLUMNS} rows={PAGE_A} />);

    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.getAllByRole('columnheader')).toHaveLength(1);
  });

  it('stays off when only `selectedIds` is passed without the callback', () => {
    // A half-wired call site must not render a column that can do nothing.
    render(<DataTable columns={SELECT_COLUMNS} rows={PAGE_A} selectedIds={['a']} />);

    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('adds a leading checkbox column, labelled, when the selection props are passed', () => {
    const { container } = render(
      <DataTable
        columns={SELECT_COLUMNS}
        rows={PAGE_A}
        selectedIds={[]}
        onSelectionChange={vi.fn()}
      />,
    );

    expect(screen.getAllByRole('columnheader')).toHaveLength(2);
    expect(screen.getByRole('checkbox', { name: 'Select all on page' })).toBeInTheDocument();
    expect(screen.getAllByLabelText('Select row')).toHaveLength(2);
    // Leading, and native — the platform supplies Space, so "keyboard support" is not something
    // the component has to rebuild at runtime.
    expect(container.querySelector('thead th:first-child input')).toBe(
      screen.getByRole('checkbox', { name: 'Select all on page' }),
    );
    expect(rowInput('a').tagName).toBe('INPUT');
  });

  it('toggles a row and reports the complete next selection with its count', () => {
    const onSelectionChange = vi.fn();
    render(
      <DataTable
        columns={SELECT_COLUMNS}
        rows={PAGE_A}
        selectedIds={[]}
        onSelectionChange={onSelectionChange}
      />,
    );

    fireEvent.click(rowInput('a'));
    // The whole array, not a delta — the caller's update is a plain replacement.
    expect(onSelectionChange).toHaveBeenCalledWith(['a'], 1);
  });

  it('reports an uncheck as the id removed, again with the count', () => {
    const onSelectionChange = vi.fn();
    render(
      <DataTable
        columns={SELECT_COLUMNS}
        rows={PAGE_A}
        selectedIds={['a', 'b']}
        onSelectionChange={onSelectionChange}
      />,
    );

    fireEvent.click(rowInput('a'));
    expect(onSelectionChange).toHaveBeenCalledWith(['b'], 1);
  });

  it('selects every row on the CURRENT page from the header checkbox', () => {
    const onSelectionChange = vi.fn();
    render(
      <DataTable
        columns={SELECT_COLUMNS}
        rows={PAGE_A}
        selectedIds={['c']}
        onSelectionChange={onSelectionChange}
      />,
    );

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all on page' }));
    expect(onSelectionChange).toHaveBeenCalledWith(['a', 'b', 'c'], 3);
  });

  it('DEselects only the page rows from a full page, leaving other pages untouched', () => {
    // Two contracts in one click: select-all is page-scoped, and so is its inverse — 'c' belongs
    // to a page the user is not looking at and must survive the unselect-all.
    const onSelectionChange = vi.fn();
    render(
      <DataTable
        columns={SELECT_COLUMNS}
        rows={PAGE_A}
        selectedIds={['a', 'b', 'c']}
        onSelectionChange={onSelectionChange}
      />,
    );

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all on page' }));
    expect(onSelectionChange).toHaveBeenCalledWith(['c'], 1);
  });

  it('marks the header checkbox indeterminate on a partial page', () => {
    const { rerender } = render(
      <DataTable
        columns={SELECT_COLUMNS}
        rows={PAGE_A}
        selectedIds={['a']}
        onSelectionChange={vi.fn()}
      />,
    );
    const header = screen.getByRole('checkbox', {
      name: 'Select all on page',
    }) as HTMLInputElement;
    // Native input means native semantics: `indeterminate` is what a screen reader announces as
    // mixed, not a class or a data attribute.
    expect(header).not.toBeChecked();
    expect(header.indeterminate).toBe(true);

    rerender(
      <DataTable
        columns={SELECT_COLUMNS}
        rows={PAGE_A}
        selectedIds={['a', 'b']}
        onSelectionChange={vi.fn()}
      />,
    );
    expect(header).toBeChecked();
    expect(header.indeterminate).toBe(false);

    rerender(
      <DataTable
        columns={SELECT_COLUMNS}
        rows={PAGE_A}
        selectedIds={[]}
        onSelectionChange={vi.fn()}
      />,
    );
    expect(header).not.toBeChecked();
    expect(header.indeterminate).toBe(false);
  });

  it('keeps selections across a page change, because the caller owns the state', () => {
    // The component is stateless about selection: the pager swaps `rows`, and whatever ids the
    // page still holds stay selected — here 'a', which page B does not even render. Retention is
    // by construction, which is also why there is nothing to assert about the component clearing
    // it: it has nowhere to clear FROM.
    const onSelectionChange = vi.fn();
    const { rerender } = render(
      <DataTable
        columns={SELECT_COLUMNS}
        rows={PAGE_A}
        selectedIds={['a']}
        onSelectionChange={onSelectionChange}
      />,
    );

    rerender(
      <DataTable
        columns={SELECT_COLUMNS}
        rows={PAGE_B}
        selectedIds={['a', 'c']}
        onSelectionChange={onSelectionChange}
      />,
    );

    expect(rowInput('a')).toBeNull();
    expect(rowInput('c')).toBeChecked();
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it('renders bulk actions with the count only while something is selected', () => {
    const { rerender } = render(
      <DataTable
        columns={SELECT_COLUMNS}
        rows={PAGE_A}
        selectedIds={[]}
        onSelectionChange={vi.fn()}
        bulkActions={(n) => <button type="button">{n} selected</button>}
      />,
    );

    // Empty selection, no bar — an action bar sitting empty above every table is furniture.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();

    rerender(
      <DataTable
        columns={SELECT_COLUMNS}
        rows={PAGE_A}
        selectedIds={['a', 'b']}
        onSelectionChange={vi.fn()}
        bulkActions={(n) => <button type="button">{n} selected</button>}
      />,
    );
    expect(screen.getByRole('button', { name: '2 selected' })).toBeInTheDocument();
  });

  it('keeps a row checkbox click and Space from activating the row', () => {
    // The checkbox is a control in the row, not the row: click and key events must stop at it, or
    // toggling a selection also opens whatever the row opens.
    const onRowClick = vi.fn();
    render(
      <DataTable
        columns={SELECT_COLUMNS}
        rows={PAGE_A}
        selectedIds={[]}
        onSelectionChange={vi.fn()}
        onRowClick={onRowClick}
      />,
    );

    fireEvent.click(rowInput('a'));
    fireEvent.keyDown(rowInput('a'), { key: ' ' });
    expect(onRowClick).not.toHaveBeenCalled();
  });
});

/** Re-render into a clean document, for the one test that needs two trees in sequence. */
function cleanupAndRender(ui: React.ReactElement): void {
  document.body.innerHTML = '';
  render(ui);
}
