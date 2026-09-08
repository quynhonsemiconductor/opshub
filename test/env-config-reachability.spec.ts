/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every variable the env schema declares is read by something.
 *
 * WHY THIS IS NOT TIDINESS. A declared variable is a promise: it appears in the schema, it gets a
 * default and a docblock, `.env.example` lists it, and infra can set it. An operator reasonably concludes
 * that setting it does something. When nothing reads it, the promise is false in the worst way — the
 * feature looks configured and is not, and the only symptom is the absence of an effect nobody is
 * watching for.
 *
 * TWO WERE FOUND BY WRITING THIS:
 *
 *   - `MAIL_REPLY_TO`. The provider interface carries `replyTo`, `sendTemplate` accepts it per call, and
 *     no caller ever passed one. Setting a reply-to address produced mail with none, so replies went to
 *     a `no-reply` sender.
 *   - `OTEL_WORKER_SERVICE_NAME`. The shared bootstrap takes the env var NAME as an option precisely so
 *     two services in one repo can be named apart, and the worker never passed it — so the worker fell
 *     back to the api's variable. Deployed environments set `OTEL_SERVICE_NAME` per task and were fine;
 *     local and any environment setting only the worker variable were not.
 *
 * Both are the same shape as the rate limiter keying on the IP and the idempotency header being blocked
 * by CORS: a mechanism that exists, is documented, and does not apply. That shape does not announce
 * itself, so it needs a check rather than a reviewer.
 *
 * __dirname, not import.meta.dirname: this suite runs as CommonJS.
 */

const ROOT = join(__dirname, '..');
const SCHEMA = 'libs/platform/src/config/env.schema.ts';

/**
 * Variables read by code OUTSIDE this repository, from `process.env` directly.
 *
 * `@quynhonsemiconductor/observability`'s bootstrap runs before Nest exists, so it cannot use `AppConfigService` — it
 * reads these itself (`otel.bootstrap.js`: `process.env['OTEL_ENABLED']`, `process.env`
 * `['OTEL_EXPORTER_OTLP_ENDPOINT']`). They are declared here so the schema still validates and documents
 * them, which is the right call and is invisible to a search of our own source.
 *
 * Listed by NAME rather than skipped by a pattern: a prefix rule would also excuse the next dead
 * `OTEL_*` knob, which is exactly the one this file exists to catch.
 */
const READ_BY_SHARED_PACKAGES = new Set([
  'OTEL_ENABLED',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_SERVICE_NAMESPACE',
  // The bootstrap's own default for the service name, read when no `serviceNameEnvVar` overrides it —
  // which is the api's case.
  'OTEL_SERVICE_NAME',
]);

/**
 * Variables consumed inside the schema itself.
 *
 * `VALKEY_URL` is the infra-injected alias for `REDIS_URL` and is normalised into it at parse time, so it
 * is read exactly once — in the file that declares it, which the scan excludes.
 */
const RESOLVED_IN_SCHEMA = new Set(['VALKEY_URL']);

function declaredKeys(): string[] {
  const schema = readFileSync(join(ROOT, SCHEMA), 'utf8');
  return [...schema.matchAll(/^\s+([A-Z][A-Z0-9_]+):\s/gm)].map((m) => m[1]);
}

function sourceFiles(): string[] {
  return (
    execFileSync(
      'git',
      // `--others --exclude-standard` too: a new consumer is likeliest to be an unstaged file, and a var
      // added and wired in one commit must not look dead in between.
      ['ls-files', '--cached', '--others', '--exclude-standard', 'libs', 'apps', 'db', 'test'],
      { cwd: ROOT, encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean)
      .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
      .filter((f) => !f.includes('/generated/'))
      .filter((f) => f !== SCHEMA)
      /*
       * AND NOT THIS FILE. It names both variables in its own assertions, so including it made the corpus
       * satisfy the check — removing the real wiring from `apps/worker/src/otel.ts` left the scan green
       * because the regex literal down in the third test still matched. A checker that counts itself as a
       * consumer cannot detect anything being disconnected.
       */
      .filter((f) => f !== 'test/env-config-reachability.spec.ts')
      .filter((f) => existsSync(join(ROOT, f)))
  );
}

function unreadKeys(): string[] {
  const keys = declaredKeys();
  const corpus = sourceFiles()
    .map((f) => readFileSync(join(ROOT, f), 'utf8'))
    .join('\n');

  return keys.filter((key) => {
    if (READ_BY_SHARED_PACKAGES.has(key) || RESOLVED_IN_SCHEMA.has(key)) return false;
    // The three ways this product reads configuration. Anchored to a read rather than a mention, so a
    // variable named only in a comment or a test fixture still counts as unread.
    const patterns = [
      new RegExp(`get\\(\\s*['"\`]${key}['"\`]`),
      new RegExp(`process\\.env\\.${key}\\b`),
      new RegExp(`process\\.env\\[\\s*['"\`]${key}['"\`]`),
      /*
       * Handed to something that reads it. `startOtel({ serviceNameEnvVar: 'OTEL_WORKER_SERVICE_NAME' })`
       * never touches the value here — it passes the NAME to a bootstrap that runs before Nest and reads
       * `process.env` itself. Still a read, and still specific: the name has to appear in a wiring
       * position, not merely somewhere in the file.
       */
      new RegExp(`EnvVar:\\s*['"\`]${key}['"\`]`),
    ];
    return !patterns.some((re) => re.test(corpus));
  });
}

describe('env config reachability', () => {
  it('finds the schema and a plausible number of variables', () => {
    /*
     * The floor. Every assertion below is "no key matched nothing", which an empty key list satisfies
     * perfectly — so the scan must first prove it is reading a schema with variables in it.
     */
    const keys = declaredKeys();
    expect(
      keys.length,
      'the env schema parsed to almost no variables — the matcher is broken',
    ).toBeGreaterThan(30);
    expect(
      keys,
      'a known variable is missing, so the matcher is not reading declarations',
    ).toContain('DATABASE_URL');
    expect(sourceFiles().length, 'the scanner sees almost no source files').toBeGreaterThan(100);
  });

  it('has no declared variable that nothing reads', () => {
    const unread = unreadKeys();

    if (unread.length > 0) {
      throw new Error(
        `${unread.length} env variable(s) are declared and read by nothing:\n` +
          unread.map((k) => `  ${k}`).join('\n') +
          '\n\nA declared variable is a promise that setting it does something. Wire it, delete it, or — ' +
          'if a shared package reads it from `process.env` before Nest exists — add it to ' +
          '`READ_BY_SHARED_PACKAGES` with the reason.',
      );
    }

    expect(unread).toEqual([]);
  });

  it('still reads the two that were dead when this was written', () => {
    /*
     * The converse, and the reason it names them: the check above passes just as well if somebody deletes
     * the variables instead of wiring them. Deleting `MAIL_REPLY_TO` would be a defensible choice — but it
     * would be a decision about a product feature, and it should not be reachable by satisfying a lint.
     */
    const corpus = sourceFiles()
      .map((f) => readFileSync(join(ROOT, f), 'utf8'))
      .join('\n');

    expect(
      corpus,
      'MAIL_REPLY_TO is unwired again — reply-to falls back to the no-reply sender',
    ).toMatch(/get\(\s*'MAIL_REPLY_TO'\s*\)/);
    expect(
      corpus,
      'the worker no longer names itself from OTEL_WORKER_SERVICE_NAME, so its spans land under the api',
    ).toMatch(/serviceNameEnvVar:\s*'OTEL_WORKER_SERVICE_NAME'/);
  });
});
