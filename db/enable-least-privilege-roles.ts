/**
 * Grant LOGIN to the least-privilege Postgres roles, then PROVE they are not
 * over-privileged. This is step 2 of docs/runbooks/db-role-least-privilege.md.
 *
 * Migration 0012 creates `opshub_app` and `opshub_worker` NOLOGIN, because giving a
 * role a password is a deliberate cutover step, not something a migration should do
 * on every deploy. This script is that step, and it runs in two places:
 *
 *  - CI, before the e2e job, so the whole suite connects as `opshub_app` instead of
 *    the owner. Without that the split is untested: every other job connects as an
 *    owner, so a table or sequence migration 0012 forgot to GRANT would pass CI and
 *    surface only after the real cutover, as `permission denied for …` on a route
 *    nobody associated with a database migration.
 *
 *  - The deployed environments, as a one-off ECS task on the MIGRATOR task
 *    definition — the only workload holding the RDS master credential and sitting in
 *    the database's subnets. RDS is not publicly accessible and ECS Exec is off, so
 *    there is no other path in:
 *      aws ecs run-task --task-definition opshub-<env>-migrator \
 *        --overrides '{"containerOverrides":[{"name":"migrator",
 *          "command":["node","dist/db/enable-least-privilege-roles.js"]}]}'
 *
 * Idempotent: ALTER ROLE sets the password to whatever value it is given, so a
 * re-run with the same secret is a no-op, and it is safe to run before the infra
 * flag flip — the roles simply sit unused until something connects as them.
 *
 * Lives in db/ rather than a scripts/ directory so it compiles into dist/db via
 * tsconfig.migrator.json and ships in the migrator image, and so it reuses this
 * repo's DSN composition instead of re-deriving it.
 */
// Load .env for local dev; in CI and ECS the env vars are injected directly.
try {
  process.loadEnvFile('.env');
} catch {
  /* no .env file — CI or container mode */
}

import { Client } from 'pg';
import { pgOptions } from './pg-ssl';
import { resolveMigrationUrl } from './database-url';
import { log } from './script-log';

interface Target {
  role: string;
  /**
   * NAME of the env var holding this role's password. Absent value = skip the role.
   *
   * Called `envVar` rather than `passwordEnv` deliberately. CodeQL's
   * `js/clear-text-logging` rule treats a read of any password-shaped identifier as
   * tainted, so listing these names in an error message registered as logging a
   * credential — correctly by its own heuristic, which cannot know the field holds a
   * variable's NAME rather than its value. A name that says what the field is keeps the
   * scanner and the reader in agreement, and needs no second copy of the list to work
   * around it.
   */
  envVar: string;
}

/**
 * The roles this script knows how to enable, and where each password comes from.
 *
 * A role whose password env var is unset is SKIPPED, not defaulted. That is what lets
 * one script serve both callers: CI supplies only `opshub_app` (the e2e suite is its
 * only consumer), while the deployed one-off task supplies both from the
 * `db-app-password` / `db-worker-password` secrets. Defaulting instead would mean a
 * typo in the secret wiring silently set a guessable password on a real role.
 */
const TARGETS: Target[] = [
  { role: 'opshub_app', envVar: 'DATABASE_APP_PASSWORD' },
  { role: 'opshub_worker', envVar: 'DATABASE_WORKER_PASSWORD' },
];

/**
 * Remove every supplied password from a string before it is logged.
 *
 * This closes a narrow but real path, not just a scanner complaint. `ALTER ROLE ... PASSWORD
 * '...'` cannot be parameterised — Postgres has no bind form for it — so the value is part
 * of the statement text, and a server-side error can quote the statement it failed on. That
 * would put a live credential into CI logs and CloudWatch, where it long outlives the
 * failure that produced it.
 *
 * Applied at every point an error message is printed, rather than trusting the callers of
 * `throw` to be careful: the messages we control already avoid the value, but a `pg` error
 * or a future edit is not something a convention can cover.
 */
function redact(message: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (acc, secret) => (secret ? acc.split(secret).join('[REDACTED]') : acc),
    message,
  );
}

/**
 * Attributes that must all be false on a least-privilege role. `rolsuper` and
 * `rolbypassrls` are the ones that would make the whole split decorative —
 * bypassrls in particular, since the point of moving off the owner is to stop
 * Postgres exempting it from row-level security.
 */
const FORBIDDEN_ATTRIBUTES = [
  'rolsuper',
  'rolbypassrls',
  'rolcreatedb',
  'rolcreaterole',
  'rolreplication',
] as const;

/**
 * A schema the DDL probe can attempt to write in. Any application schema works; this
 * one is picked because it exists in every environment from migration 0001.
 */
const PROBE_SCHEMA = 'workforce';

/**
 * Schemas the runtime roles have no business in, so every OTHER schema is an application
 * schema.
 *
 * DERIVED RATHER THAN LISTED, and that is the point. This check used to hold its own copy
 * of migration 0012's `app_schemas`, which meant a schema created by a LATER migration was
 * invisible to it: six of them had accumulated (`contracts`, `documents`, `isms`,
 * `positions`, `qms`, `training`) and none were being verified — the exact hole the check
 * exists to close, reopened by the list going stale. A blacklist cannot go stale in that
 * direction: a new schema is covered the moment it is created, and nobody has to remember
 * anything.
 *
 * `drizzle` holds the migration bookkeeping and belongs to the migrator alone — the app
 * having no privilege on it is CORRECT, not a gap. `public` holds no application tables.
 */
const NON_APP_SCHEMAS = ['drizzle', 'public', 'information_schema'] as const;

/**
 * Tables the runtime roles are deliberately NOT allowed to write, and why.
 *
 * Two kinds, both restricted by REVOKE in the migration that created them (a narrower GRANT
 * changes nothing — see migration 0022):
 *
 *   REFERENCE DATA, seeded by migration and changed only by another one. A classification
 *   scheme or an accrual policy is reviewed, not typed in by whoever holds the manage
 *   permission.
 *
 *   APPEND-ONLY history, where the row IS the evidence. An UPDATE privilege on a table whose
 *   purpose is to record what happened is a privilege to rewrite the record.
 *
 * VERIFIED IN BOTH DIRECTIONS by {@link assertPrivilegesAreExactlyAsDeclared}: a listed
 * privilege must really be denied, so this cannot decay into a list of excuses for grants
 * that were quietly restored, and an unlisted one must be held.
 */
const RESTRICTED_TABLES: { table: string; denied: readonly Privilege[]; why: string }[] = [
  {
    table: 'isms.classification_levels',
    denied: ['INSERT', 'UPDATE', 'DELETE'],
    why: 'reference data: the classification scheme itself',
  },
  {
    table: 'isms.vendor_criticality_levels',
    denied: ['INSERT', 'UPDATE', 'DELETE'],
    why: 'reference data: the vendor criticality tiers',
  },
  {
    table: 'qms.nonconformance_severities',
    denied: ['INSERT', 'UPDATE', 'DELETE'],
    why: 'reference data: the severity scale and its response times',
  },
  {
    table: 'workforce.leave_policies',
    denied: ['INSERT', 'UPDATE', 'DELETE'],
    why: 'reference data: accrual method and carry-over caps are policy',
  },
  {
    table: 'performance.rating_scale',
    denied: ['INSERT', 'UPDATE', 'DELETE'],
    why: 'reference data: the rating scale and which grades demand a development plan',
  },
  {
    table: 'isms.asset_classification_history',
    denied: ['UPDATE', 'DELETE'],
    why: 'append-only: the record of every classification an asset has held',
  },
  {
    table: 'isms.incident_events',
    denied: ['UPDATE', 'DELETE'],
    why: 'append-only: the incident timeline',
  },
  {
    table: 'isms.vendor_assessments',
    denied: ['UPDATE', 'DELETE'],
    why: 'append-only: each assessment is a dated judgement, superseded and not edited',
  },
];

const DML_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const;
type Privilege = (typeof DML_PRIVILEGES)[number];

/**
 * Assert the role holds EXACTLY the privileges it is meant to: everything on every
 * application table, minus the writes {@link RESTRICTED_TABLES} says it must not have.
 *
 * The DDL probe below samples one table; this is exhaustive, and it is the check that
 * actually protects the cutover. A table nobody granted — one added by a later migration in
 * a schema created after 0012, say — is invisible until a request touches it, and then it is
 * a 500 in production on a code path that has nothing obviously to do with a database
 * migration. Running the e2e suite as this role catches only the tables the suite happens to
 * touch.
 *
 * BOTH DIRECTIONS MATTER. A missing privilege breaks a feature loudly; an EXTRA one breaks
 * an invariant silently, and a reference table or an append-only history that quietly became
 * writable is exactly the failure this repo keeps finding — a restriction that was declared
 * and never enforced. So a privilege listed as denied must really be denied, and a table
 * listed here that no longer exists is an error too, because a stale entry is an exemption
 * nobody is checking.
 *
 * `has_table_privilege` resolves inherited grants and role membership, so this answers the
 * real question — can this role do it — rather than inspecting grant rows.
 */
async function assertPrivilegesAreExactlyAsDeclared(admin: Client, role: string): Promise<void> {
  const { rows } = await admin.query<{ tbl: string; priv: Privilege; held: boolean }>(
    `SELECT t.table_schema || '.' || t.table_name AS tbl,
            p.priv,
            has_table_privilege($1, t.table_schema || '.' || t.table_name, p.priv) AS held
       FROM information_schema.tables t
       CROSS JOIN unnest($2::text[]) AS p(priv)
      WHERE t.table_type = 'BASE TABLE'
        AND t.table_schema <> ALL($3::text[])
        AND t.table_schema NOT LIKE 'pg\\_%'
      ORDER BY 1, 2`,
    [role, [...DML_PRIVILEGES], [...NON_APP_SCHEMAS]],
  );

  const restricted = new Map(RESTRICTED_TABLES.map((r) => [r.table, r]));
  const seen = new Set<string>();
  const missing = new Map<string, Privilege[]>();
  const unexpected = new Map<string, Privilege[]>();

  for (const row of rows) {
    seen.add(row.tbl);
    const shouldBeDenied = restricted.get(row.tbl)?.denied.includes(row.priv) ?? false;
    if (shouldBeDenied === row.held) {
      const into = row.held ? unexpected : missing;
      into.set(row.tbl, [...(into.get(row.tbl) ?? []), row.priv]);
    }
  }

  const problems: string[] = [];
  if (missing.size > 0) {
    problems.push(
      `${role} is missing privileges on ${missing.size} table(s), so it would fail at ` +
        `runtime on any request touching them:\n` +
        [...missing].map(([tbl, ps]) => `    ${tbl} — missing ${ps.join(', ')}`).join('\n') +
        `\n  Grant the table in the migration that created it, the way every schema added ` +
        `after 0012 does.`,
    );
  }
  if (unexpected.size > 0) {
    problems.push(
      `${role} holds privileges that RESTRICTED_TABLES says it must not, so a restriction ` +
        `this repo declared is not being enforced:\n` +
        [...unexpected]
          .map(
            ([tbl, ps]) =>
              `    ${tbl} — holds ${ps.join(', ')} (${restricted.get(tbl)?.why ?? 'unknown'})`,
          )
          .join('\n') +
        `\n  Either the REVOKE is missing from a migration, or a later migration re-granted ` +
        `it — ALTER DEFAULT PRIVILEGES re-attaches writes at CREATE TABLE.`,
    );
  }
  const vanished = RESTRICTED_TABLES.filter((r) => !seen.has(r.table)).map((r) => r.table);
  if (vanished.length > 0) {
    problems.push(
      `RESTRICTED_TABLES names ${vanished.length} table(s) that no longer exist, and a stale ` +
        `exemption is one nobody is checking:\n` +
        vanished.map((t) => `    ${t}`).join('\n') +
        `\n  Remove the entry, or fix the name.`,
    );
  }

  if (problems.length > 0) throw new Error(problems.join('\n\n'));

  const tables = seen.size;
  log.info(
    `    ${role}: all four DML privileges on ${tables} tables, ` +
      `minus the declared restrictions on ${RESTRICTED_TABLES.length} of them.`,
  );
}

/**
 * `ALTER ROLE` is utility DDL: the grammar accepts neither an identifier nor a
 * password as a bind parameter, so both have to be interpolated. Validate them
 * instead. This runs against REAL databases, not just an ephemeral CI one, so an
 * unchecked interpolation here would be an injection sink with production reach.
 */
function assertSafeRole(role: string): void {
  if (!/^[a-z_][a-z0-9_]*$/.test(role)) {
    throw new Error(`Refusing to interpolate an unsafe role name: ${role}`);
  }
}

function assertSafePassword(role: string, envVar: string, password: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(password)) {
    throw new Error(
      `${envVar} must be [A-Za-z0-9_-] only (it is the password for ${role}). ` +
        'database-url.ts composes a DSN from parts and percent-encodes them, but ' +
        'restricting the charset sidesteps encoding questions entirely — see the runbook.',
    );
  }
  if (password.length < 24) {
    throw new Error(
      `${envVar} is ${password.length} characters. Use at least 24 — this is a ` +
        'credential for a role with write access to every application table.',
    );
  }
}

/** Enable one role and verify it. Throws on anything unexpected. */
async function enableRole(
  adminUrl: string,
  admin: Client,
  target: Target,
  password: string,
): Promise<void> {
  const { role } = target;
  assertSafeRole(role);
  assertSafePassword(role, target.envVar, password);

  const exists = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  if (exists.rows.length === 0) {
    throw new Error(
      `Role ${role} does not exist. Migration 0012 should have created it — ` +
        'has db:migrate run against this database?',
    );
  }

  // `escapeIdentifier`/`escapeLiteral` rather than hand-quoting. Postgres has no bind form
  // for `ALTER ROLE ... PASSWORD`, so the values must be part of the statement text — but
  // that is a reason to use the driver's own quoting, not a reason to interpolate raw. The
  // regex validation above stays as defence in depth: it constrains what can arrive here at
  // all, while this constrains what the SQL can mean.
  //
  // Any failure is re-thrown WITHOUT the driver's message, because a server-side error can
  // quote the statement it failed on — and this statement contains a live credential.
  try {
    await admin.query(
      `ALTER ROLE ${admin.escapeIdentifier(role)} LOGIN PASSWORD ${admin.escapeLiteral(password)}`,
    );
  } catch {
    throw new Error(
      `ALTER ROLE failed for ${role}. The driver's message is withheld deliberately: it can ` +
        'quote the failing statement, which carries the password. Check the role exists and ' +
        'that the admin connection has rights to alter it.',
    );
  }

  // Assert the role gained LOGIN and nothing else. A role that is superuser or
  // bypasses RLS is WORSE than the master credential it replaces, because it looks
  // restricted.
  const attrs = await admin.query<Record<string, boolean>>(
    `SELECT rolcanlogin, ${FORBIDDEN_ATTRIBUTES.join(', ')} FROM pg_roles WHERE rolname = $1`,
    [role],
  );
  const row = attrs.rows[0];
  if (!row?.['rolcanlogin']) {
    throw new Error(`${role} still cannot log in after ALTER ROLE. Nothing else was changed.`);
  }
  const granted = FORBIDDEN_ATTRIBUTES.filter((a) => row[a]);
  if (granted.length > 0) {
    throw new Error(
      `${role} holds privileged attributes it must not have: ${granted.join(', ')}. ` +
        'Fix the role before pointing any workload at it.',
    );
  }

  await assertPrivilegesAreExactlyAsDeclared(admin, role);

  // Two probes as the role itself. The positive one matters as much as the negative:
  // a role that cannot run DDL *because it cannot do anything* would pass the check
  // below and then fail every request after cutover.
  const roleUrl = new URL(adminUrl);
  roleUrl.username = role;
  roleUrl.password = password;

  const client = new Client(pgOptions(roleUrl.toString()));
  await client.connect();
  try {
    // Positive: the grants from 0012 actually reached this role.
    await client.query(`SELECT 1 FROM ${PROBE_SCHEMA}.timesheets LIMIT 1`);

    // Negative: DML rights only. Wrapped in a transaction that ALWAYS rolls back, so
    // a failure part-way cannot leave a stray probe table in a real schema.
    let ddlAllowed = false;
    try {
      await client.query('BEGIN');
      await client.query(`CREATE TABLE ${PROBE_SCHEMA}.privilege_probe (id int)`);
      ddlAllowed = true;
    } catch {
      // Expected: permission denied. DML-only is the whole point of the role.
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
    }

    if (ddlAllowed) {
      throw new Error(
        `${role} was able to CREATE TABLE. It must hold DML rights only — check the ` +
          'GRANTs in db/migrations/0012_app_role_least_privilege.sql.',
      );
    }
  } finally {
    await client.end();
  }

  log.info(
    `✅  ${role}: can log in, can read its tables, holds no privileged attributes, cannot run DDL.`,
  );
}

async function run(): Promise<void> {
  // Resolves DATABASE_MIGRATION_URL, else DATABASE_URL, else composes from the
  // DATABASE_* parts — the deployed path, where the migrator's master credential
  // arrives straight from the RDS-managed secret.
  let adminUrl: string;
  try {
    adminUrl = resolveMigrationUrl();
  } catch (err) {
    log.error({ err }, (err as Error).message);
    process.exit(1);
  }

  const requested = TARGETS.map((t) => ({
    target: t,
    password: process.env[t.envVar],
  })).filter((r): r is { target: Target; password: string } => Boolean(r.password));

  if (requested.length === 0) {
    log.error(
      `No role passwords supplied. Set at least one of: ${TARGETS.map((t) => t.envVar).join(', ')}.`,
    );
    process.exit(1);
  }

  // Every value that must never reach a log, gathered once so the error paths below cannot
  // each be individually correct-or-not.
  const secrets = requested.map((r) => r.password);

  const admin = new Client(pgOptions(adminUrl));
  await admin.connect();
  try {
    for (const { target, password } of requested) {
      await enableRole(adminUrl, admin, target, password);
    }
  } catch (err) {
    // The message only, redacted: an `err` object would carry the unredacted text in its message and stack.
    log.error(redact((err as Error).message, secrets));
    process.exitCode = 1;
  } finally {
    await admin.end();
  }
}

void run();
