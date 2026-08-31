/**
 * Client-side CSV export for the report panels.
 *
 * The report endpoints return WHOLE result sets — none of them pages — so the export is built from the
 * array the panel already holds, in the browser, with no backend round trip. If a report ever grows a
 * pager, this file is the thing to revisit, not each panel.
 *
 * Functions only, no components: `report-parts.tsx` cannot host them without losing Fast Refresh for the
 * whole panel-parts file (the same rule that keeps `report-config.ts` component-free).
 */
import { todayIso } from '@/shared/lib/format';

/** A cell as it lands in the CSV. `null` / `undefined` become an empty field, not the string "null". */
export type CsvCell = string | number | boolean | null | undefined;

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => CsvCell;
}

/**
 * ONE FIELD, RFC 4180. A field is quoted only when it has to be — a quote, a comma or a line break —
 * and embedded quotes are doubled. Quoting every field unconditionally is also conformant, but a file
 * where every cell carries quotes is noise to diff and to read, and Excel does not care either way.
 *
 * A field starting with `=`, `+`, `-` or `@` is prefixed with a leading `'` first — Excel/Sheets read
 * an unguarded leading one of those as a formula, so a vendor name or note field containing one is a
 * live CSV-injection vector (e.g. `=cmd|'/c calc'!A1`) otherwise. The `'` is invisible once opened.
 */
function escapeCell(cell: CsvCell): string {
  if (cell === null || cell === undefined) return '';
  const raw = String(cell);
  const field = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field;
}

/**
 * The file, BOM first.
 *
 * THE BOM IS NOT DECORATION. Without it Excel reads the bytes in the machine's legacy code page, and the
 * first row of every non-ASCII value — vendor names, the accented and the Cyrillic — arrives mangled.
 * The BOM is what makes Excel commit to UTF-8.
 *
 * CRLF, not LF, for the same audience: RFC 4180 specifies it and older Excel builds treat a bare LF as
 * one long row.
 */
export function toCsv<T>(rows: readonly T[], columns: readonly CsvColumn<T>[]): string {
  const lines = [columns.map((c) => escapeCell(c.header)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => escapeCell(c.value(row))).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}`;
}

/** `{report-name}-{yyyy-mm-dd}.csv`, the report title slugified — "SLA Compliance" → `sla-compliance`. */
export function csvFilename(report: string): string {
  const slug = report
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug}-${todayIso()}.csv`;
}

/**
 * The blob, as a download — object URL, a synthetic anchor click, and the URL revoked behind it.
 *
 * The anchor is appended to the document before the click because Firefox ignores a click on a node
 * that is not in the tree, and removed after because nothing else should ever see it.
 */
export function downloadCsv(filename: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
