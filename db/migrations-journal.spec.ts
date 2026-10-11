/**
 * The migration journal is what drizzle actually applies — not the .sql files on disk.
 *
 * `drizzle-orm`'s migrator reads `meta/_journal.json`, takes the newest `created_at` already recorded in
 * the database, and applies only the journal entries whose `when` is GREATER. An entry whose `when` is
 * not above its predecessor's is therefore skipped, silently, on every database that had already applied
 * the predecessor: the file is there, `db:migrate` reports success, and the DDL never runs. A fresh
 * database applies everything in order, so CI's "apply migrations" step cannot tell.
 *
 * Entries 0004 and 0005 carried `when` values from 2025, earlier than 0003's (2026-06-27) — a
 * hand-written timestamp. They were corrected when this guard was added.
 *
 * Pinned here:
 *   - `idx` runs 0..n-1 with no gap or repeat,
 *   - `when` is STRICTLY increasing,
 *   - every entry's tag is `<idx padded to 4>_<name>` and names a file that exists,
 *   - no .sql file lacks an entry (it would never run).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface Entry {
  idx: number;
  when: number;
  tag: string;
}

/** Every way the journal can be wrong, as readable messages. Empty = sound. */
export function journalProblems(entries: Entry[], sqlFiles: string[]): string[] {
  const problems: string[] = [];
  const tags = new Set<string>();
  entries.forEach((e, i) => {
    if (e.idx !== i) problems.push(`entry ${i} has idx ${e.idx}; idx must run 0..n-1 with no gap`);
    if (!e.tag.startsWith(`${String(e.idx).padStart(4, '0')}_`)) {
      problems.push(`${e.tag}: the tag's number does not match idx ${e.idx}`);
    }
    if (tags.has(e.tag)) problems.push(`${e.tag}: listed twice`);
    tags.add(e.tag);
    if (!sqlFiles.includes(`${e.tag}.sql`))
      problems.push(`${e.tag}: no such file db/migrations/${e.tag}.sql`);
    const previous = entries[i - 1];
    if (previous && e.when <= previous.when) {
      problems.push(
        `${e.tag}: when ${e.when} is not above ${previous.tag}'s ${previous.when} — drizzle will SKIP it ` +
          `on any database that already applied ${previous.tag}`,
      );
    }
  });
  for (const file of sqlFiles) {
    if (!tags.has(file.replace(/\.sql$/, ''))) {
      problems.push(`${file}: not in the journal, so it will never run`);
    }
  }
  return problems;
}

const dir = join(__dirname, 'migrations');

describe('migration journal', () => {
  const journal = JSON.parse(readFileSync(join(dir, 'meta/_journal.json'), 'utf8')) as {
    entries: Entry[];
  };
  const sqlFiles = readdirSync(dir).filter((f) => f.endsWith('.sql'));

  it('is the journal this guard reads (and not an empty one)', () => {
    expect(journal.entries.length).toBeGreaterThan(30);
    expect(sqlFiles.length).toBe(journal.entries.length);
  });

  it('is sound: contiguous idx, strictly increasing when, every tag a file, no orphan file', () => {
    expect(journalProblems(journal.entries, sqlFiles)).toEqual([]);
  });
});

describe('journalProblems — each defect is caught', () => {
  const ok: Entry[] = [
    { idx: 0, when: 100, tag: '0000_a' },
    { idx: 1, when: 200, tag: '0001_b' },
    { idx: 2, when: 300, tag: '0002_c' },
  ];
  const files = ['0000_a.sql', '0001_b.sql', '0002_c.sql'];

  it('accepts a sound journal', () => {
    expect(journalProblems(ok, files)).toEqual([]);
  });

  it('catches a `when` that is not above its predecessor (the entry drizzle would skip)', () => {
    const bad = ok.map((e) => (e.idx === 1 ? { ...e, when: 100 } : e));
    expect(journalProblems(bad, files).join('\n')).toMatch(
      /0001_b: when 100 is not above 0000_a.*SKIP/,
    );
    const earlier = ok.map((e) => (e.idx === 2 ? { ...e, when: 50 } : e));
    expect(journalProblems(earlier, files).join('\n')).toMatch(/0002_c: when 50/);
  });

  it('catches a gap or repeat in idx', () => {
    const gap = [ok[0], { idx: 2, when: 200, tag: '0002_c' }];
    expect(journalProblems(gap, files).join('\n')).toMatch(/idx must run 0\.\.n-1/);
  });

  it('catches a tag whose number does not match its idx', () => {
    const bad = ok.map((e) => (e.idx === 1 ? { ...e, tag: '0009_b' } : e));
    expect(journalProblems(bad, ['0000_a.sql', '0009_b.sql', '0002_c.sql']).join('\n')).toMatch(
      /number does not match idx 1/,
    );
  });

  it('catches an entry with no file', () => {
    expect(journalProblems(ok, ['0000_a.sql', '0001_b.sql']).join('\n')).toMatch(
      /0002_c: no such file/,
    );
  });

  it('catches a file with no entry (it would never run)', () => {
    expect(journalProblems(ok, [...files, '0003_d.sql']).join('\n')).toMatch(
      /0003_d.sql: not in the journal/,
    );
  });
});
