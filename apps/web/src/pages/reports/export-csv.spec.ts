// @vitest-environment jsdom
/**
 * The CSV writer, at its edge cases.
 *
 * ESCAPING IS THE WHOLE RISK. A report cell holds free text — a vendor named `Acme, Inc.`, a note with a
 * quote in it, a description someone pasted a line break into — and one unescaped comma silently shifts
 * every cell after it into the wrong column of somebody's spreadsheet. So each rule RFC 4180 asks for is
 * asserted here against the exact bytes: quote-when-needed, doubled embedded quotes, CRLF rows, the BOM
 * that makes Excel read the file as UTF-8, and null staying an empty field rather than the string "null".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { csvFilename, downloadCsv, toCsv, type CsvColumn } from './export-csv';

interface Row {
  name: string;
  count: number;
  note?: string | null;
}

const columns: CsvColumn<Row>[] = [
  { header: 'Name', value: (r) => r.name },
  { header: 'Count', value: (r) => r.count },
  { header: 'Note', value: (r) => r.note },
];

/** The expected BOM, as a constant — the file starts with it and every assertion below builds on it. */
const BOM = '\uFEFF';

describe('toCsv', () => {
  it('quotes fields that carry a comma, a quote or a line break, doubling embedded quotes', () => {
    const csv = toCsv(
      [
        { name: 'Smith, John', count: 1 },
        { name: 'He said "hi"', count: 2 },
        { name: 'line one\nline two', count: 3 },
        { name: 'cr separated\rbreak', count: 4 },
      ],
      columns,
    );

    expect(csv).toBe(
      [
        `${BOM}Name,Count,Note`,
        `"Smith, John",1,`,
        `"He said ""hi""",2,`,
        `"line one\nline two",3,`,
        `"cr separated\rbreak",4,`,
      ].join('\r\n'),
    );
  });

  it('leaves plain fields unquoted', () => {
    const csv = toCsv([{ name: 'Acme Corp', count: 7 }], columns);
    expect(csv).toBe(`${BOM}Name,Count,Note\r\nAcme Corp,7,`);
  });

  it('writes an empty field for null and undefined, not the string "null"', () => {
    const csv = toCsv(
      [
        { name: 'a', count: 1, note: null },
        { name: 'b', count: 2, note: undefined },
      ],
      columns,
    );
    expect(csv).toBe(`${BOM}Name,Count,Note\r\na,1,\r\nb,2,`);
  });

  it('emits the header row even when there are no rows', () => {
    expect(toCsv([], columns)).toBe(`${BOM}Name,Count,Note`);
  });

  it('stringifies numbers and booleans as their natural text', () => {
    const csv = toCsv(
      [{ done: true, retries: 0 }],
      [
        { header: 'Done', value: (r) => r.done },
        { header: 'Retries', value: (r) => r.retries },
      ],
    );
    expect(csv).toBe(`${BOM}Done,Retries\r\ntrue,0`);
  });
});

describe('csvFilename', () => {
  /** The date half, derived the same way the helper does: today, in the reader's timezone. */
  function today() {
    const now = new Date();
    const month = `${now.getMonth() + 1}`.padStart(2, '0');
    const day = `${now.getDate()}`.padStart(2, '0');
    return `${now.getFullYear()}-${month}-${day}`;
  }

  it('slugs the report name and appends today as YYYY-MM-DD', () => {
    expect(csvFilename('SLA Compliance')).toBe(`sla-compliance-${today()}.csv`);
  });

  it('collapses punctuation and runs of space into one dash', () => {
    expect(csvFilename('Cycle Time (p50 / p90)')).toBe(`cycle-time-p50-p90-${today()}.csv`);
    expect(csvFilename('Requests by Type and Status')).toBe(
      `requests-by-type-and-status-${today()}.csv`,
    );
  });
});

describe('downloadCsv', () => {
  let anchor: HTMLAnchorElement | undefined;
  const createElement = document.createElement.bind(document);
  const createdObjectUrl = vi.fn(() => 'blob:csv-mock');
  const revokedObjectUrl = vi.fn();

  beforeEach(() => {
    // jsdom ships no object URL store; the contract under test is the wiring, not the store.
    createdObjectUrl.mockClear();
    revokedObjectUrl.mockClear();
    Object.defineProperty(URL, 'createObjectURL', {
      value: createdObjectUrl,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      value: revokedObjectUrl,
      configurable: true,
      writable: true,
    });
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const element = createElement(tag);
      if (tag === 'a') anchor = element as HTMLAnchorElement;
      return element;
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    anchor = undefined;
  });

  it('clicks a named anchor at a blob URL, then revokes that URL', async () => {
    downloadCsv('report.csv', 'a,b');

    const clicked = anchor;
    expect(clicked).toBeTruthy();
    expect(clicked!.download).toBe('report.csv');
    expect(clicked!.href).toBe('blob:csv-mock');
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce();
    expect(createdObjectUrl).toHaveBeenCalledOnce();
    expect(revokedObjectUrl).toHaveBeenCalledWith('blob:csv-mock');
  });

  it('hands the writer a UTF-8 CSV blob carrying the exact bytes', async () => {
    downloadCsv('report.csv', 'Name,Count\r\nAcme,7');

    const [blob] = createdObjectUrl.mock.calls[0] as unknown as [Blob];
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('text/csv;charset=utf-8');
    await expect(blob.text()).resolves.toBe('Name,Count\r\nAcme,7');
  });
});
