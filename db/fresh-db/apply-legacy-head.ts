/**
 * Put a database in the state every pre-CNPG environment was in, so the REST of
 * the journal can be applied on top of it (the legacy half of the fresh-DB
 * rebuild gate).
 *
 * Three steps, in this order:
 *
 *  1. Apply journal entries numbered below 0012, by running Drizzle's own
 *     migrator against a copy of `db/migrations` whose journal lists only them.
 *     Using the real migrator — not `psql -f` on each file — is what records the
 *     rows in `drizzle.__drizzle_migrations` the same way a deployed run does, so
 *     the second half starts from the spot a real upgrade starts from.
 *  2. Apply `legacy-0012.sql`, the frozen copy of 0012 as it ran on AWS: it
 *     creates `opshub_app`, `opshub_worker` and the legacy `opshub_migrate`
 *     (with CREATEROLE available), grants them, and sets the per-role timeouts.
 *  3. Record 0012 in `drizzle.__drizzle_migrations` at its journal `when`, with
 *     the hash of the SQL that actually ran. The migrator compares only
 *     `created_at` (`drizzle-orm` 0.45.4, pg-core/dialect.js:57 and :62), so
 *     this is what makes the next `pnpm db:migrate` start at 0013.
 *
 * The edited 0012 now in the journal is never run on this database — that is the
 * point of the scenario: an environment that applied the OLD text must survive
 * the rest of the journal, and the grants must still end up on `opshub_app` /
 * `opshub_worker` (asserted afterwards).
 *
 * Usage: DATABASE_MIGRATION_URL=postgresql://… tsx db/fresh-db/apply-legacy-head.ts
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { log } from '../script-log';

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

const MIGRATIONS = path.resolve(__dirname, '..', 'migrations');
const LEGACY_0012 = path.resolve(__dirname, 'legacy-0012.sql');
/** The legacy head this script reproduces: the last migration before the rewrite. */
const LEGACY_NUMBER = 12;

/** The number a migration's tag starts with: `0128_rename…` → 128. */
const numberOf = (tag: string): number => Number.parseInt(tag.slice(0, 4), 10);

async function run(): Promise<void> {
  const url = process.env['DATABASE_MIGRATION_URL'];
  if (!url) {
    log.error({}, 'DATABASE_MIGRATION_URL is required (the superuser, as the RDS master was).');
    process.exit(1);
  }

  const journal = JSON.parse(
    readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8'),
  ) as Journal;

  const head = journal.entries.filter((e) => numberOf(e.tag) < LEGACY_NUMBER);
  const atLegacy = journal.entries.find((e) => numberOf(e.tag) === LEGACY_NUMBER);
  if (head.length === 0 || !atLegacy) {
    log.error(
      {},
      `The journal has no entries below 0${LEGACY_NUMBER}, or no 0${LEGACY_NUMBER} — cannot build a legacy head.`,
    );
    process.exit(1);
  }

  const folder = mkdtempSync(path.join(tmpdir(), 'opshub-legacy-head-'));
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    // Re-running is a no-op once the legacy head is in place: re-applying
    // legacy-0012.sql would re-run CREATE ROLE on a database the platform
    // already provisioned, which is not the state this script produces.
    // Two statements rather than one: a brand-new database has no bookkeeping
    // table yet, which is the normal first run — referencing it in FROM would
    // error however the row is filtered.
    const present = await pool.query<{ present: boolean }>(
      `select to_regclass('drizzle.__drizzle_migrations') is not null as present`,
    );
    const done = present.rows[0]?.present
      ? await pool.query(
          'select 1 from drizzle.__drizzle_migrations where created_at = $1 limit 1',
          [atLegacy.when],
        )
      : { rowCount: 0 };
    if ((done.rowCount ?? 0) > 0) {
      log.info(
        `Already at the legacy head (0012 recorded at when=${atLegacy.when}). Nothing to do.`,
      );
      return;
    }

    mkdirSync(path.join(folder, 'meta'), { recursive: true });
    for (const entry of head) {
      copyFileSync(
        path.join(MIGRATIONS, `${entry.tag}.sql`),
        path.join(folder, `${entry.tag}.sql`),
      );
    }
    writeFileSync(
      path.join(folder, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries: head }, null, 2),
    );

    log.info(
      `Applying ${head.length} journal entries below 0012 (last: ${head[head.length - 1]?.tag})…`,
    );
    await migrate(drizzle(pool), { migrationsFolder: folder });

    const legacySql = readFileSync(LEGACY_0012, 'utf8');
    const hash = createHash('sha256').update(legacySql).digest('hex');
    log.info('Applying legacy-0012.sql (creates opshub_app / opshub_worker / opshub_migrate)…');
    await pool.query(legacySql);

    // Re-runnable: a retried step re-applies legacy-0012.sql (it is idempotent by
    // construction), but a SECOND row at this `created_at` would be stray state —
    // 0012's slot must hold exactly one row.
    await pool.query(
      `insert into drizzle.__drizzle_migrations ("hash", "created_at")
       select $1, $2
        where not exists (
          select 1 from drizzle.__drizzle_migrations where created_at = $2
        )`,
      [hash, atLegacy.when],
    );
    log.info(
      `✅  0012 recorded at when=${atLegacy.when}; the rest of the journal applies from 0013.`,
    );
  } finally {
    rmSync(folder, { recursive: true, force: true });
    await pool.end();
  }
}

void run();
