import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { apiErrorMessage } from '@/shared/api/errors';
import { Button, Tooltip } from '@/shared/ui';
import { csvFilename, downloadCsv, toCsv, type CsvColumn } from './export-csv';

/**
 * The panel frame the charts sit in, plus their loading and error states.
 *
 * Components only — the colours, ranges and formatters live in `report-config.ts`, because a file that
 * exports both loses Fast Refresh for the components (eslint's `react-refresh/only-export-components`,
 * the same lesson as workforce and rbac).
 */

export function Card({
  title,
  actions,
  children,
  className = '',
}: {
  title: string;
  /** Header-trailing controls — the export button a panel with tabular data passes in. */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-xl border border-border bg-surface ${className}`}>
      <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
        <h3 className="text-sm font-semibold text-fg">{title}</h3>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

export function ChartSkeleton() {
  return <div className="h-48 animate-pulse rounded-lg bg-surface-muted" />;
}

export function ErrorMsg() {
  return <p className="py-4 text-center text-xs text-danger">Failed to load data</p>;
}

// ── Export ────────────────────────────────────────────────────────────────────

/**
 * The one export control, for any panel whose data is a row grid.
 *
 * IT LIVES HERE, NEXT TO `Card`, RATHER THAN IN EACH REPORT FILE. Seven panels wanted the same button and
 * the same header slot; the alternative was seven copies of the async defer and the empty-state tooltip
 * drifting apart. The panel passes its ALREADY-MAPPED display rows and columns, so the CSV is the grid on
 * screen, not a second mapping of the API response.
 *
 * THE EMPTY STATE IS A DISABLED BUTTON, not a hidden one: a control that vanishes when the window has no
 * rows teaches nobody anything, and the tooltip says why it will not press. It wraps in `Tooltip` only when
 * disabled — `Button`'s `disabled:pointer-events-none` makes a native `title` unreachable, and the shared
 * tooltip binds on its wrapper, which the pointer still crosses.
 */
export function ExportCsvButton<T>({
  name,
  columns,
  rows,
}: {
  /** The report title — the toast copy and the `{report-name}-{date}.csv` filename both derive from it. */
  name: string;
  columns: readonly CsvColumn<T>[];
  rows: readonly T[];
}) {
  const [exporting, setExporting] = useState(false);

  async function handleClick() {
    setExporting(true);
    try {
      // One tick before the string is built, so the pressed "Exporting…" state paints even for a
      // window big enough to block — the same deferral the pattern calls for when generation could matter.
      await new Promise((resolve) => setTimeout(resolve, 0));
      downloadCsv(csvFilename(name), toCsv(rows, columns));
      toast.success(`Exported ${name}`);
    } catch (err) {
      // The shared primitive, so an unexpected failure reads through the same channel as an API one.
      toast.error(apiErrorMessage(err, `Could not export ${name}.`));
    } finally {
      setExporting(false);
    }
  }

  const button = (
    <Button
      variant="outline"
      size="sm"
      onClick={handleClick}
      disabled={exporting || rows.length === 0}
      aria-label={`Export ${name} as CSV`}
    >
      {exporting ? 'Exporting…' : 'Export CSV'}
    </Button>
  );

  if (rows.length === 0) {
    return (
      <Tooltip content="No data for this period — nothing to export." placement="bottom">
        {button}
      </Tooltip>
    );
  }
  return button;
}
