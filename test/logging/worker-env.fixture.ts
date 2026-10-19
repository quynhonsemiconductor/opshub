/**
 * The worker conformance spec's environment: a MINIMAL, explicit one, replacing the process's whole environment.
 *
 * Why not the API e2e config: that one sets `BETTER_AUTH_SECRET` and `IDENTITY_TEST_LOGIN`, and loads `.env` (which has more API-only keys).
 * The worker's env schema REFUSES every API-only variable ("a worker holding BETTER_AUTH_SECRET could forge a session cookie"), so the worker
 * must be booted with only what a worker is given. Two things make that hold:
 *
 *   1. `process.env` is replaced, not extended: only the allow-list below survives from the caller's environment.
 *   2. The working directory moves to an empty directory, so `@quynhonsemiconductor/platform-runtime/load-env` (`process.loadEnvFile()`)
 *      finds no `.env` to add keys back from.
 *
 * Runs as a vitest `setupFiles` entry, i.e. before the spec imports anything.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** What a worker legitimately needs, taken from the caller's environment when present (CI supplies the services). */
const INHERIT = ['PATH', 'HOME', 'TMPDIR', 'DATABASE_URL', 'VALKEY_URL', 'REDIS_URL'] as const;

/**
 * A key from this checkout's `.env`, read before the environment is replaced. A second copy of the stack points DATABASE_URL
 * and VALKEY_URL at its own ports there, so the fixture must follow that file rather than the first copy's defaults.
 */
function dotenvValue(key: string): string | undefined {
  try {
    const line = readFileSync(join(process.cwd(), '.env'), 'utf8')
      .split('\n')
      .find((l) => l.startsWith(`${key}=`));
    return line?.slice(key.length + 1).trim() || undefined;
  } catch {
    return undefined;
  }
}

const inherited = Object.fromEntries(
  INHERIT.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])),
);

for (const key of Object.keys(process.env)) delete process.env[key];

Object.assign(process.env, {
  // Local defaults, overridden by what the caller (CI) provides.
  DATABASE_URL: dotenvValue('DATABASE_URL') ?? 'postgres://opshub:opshub@localhost:5410/opshub',
  ...(inherited['VALKEY_URL'] || inherited['REDIS_URL']
    ? {}
    : { VALKEY_URL: dotenvValue('VALKEY_URL') ?? 'redis://localhost:6310' }),
  ...inherited,
  NODE_ENV: 'production', // pinned to production in every deployed environment, on purpose
  DEPLOYMENT_ENV: 'develop',
  SERVICE_VERSION: 'sha-conformance',
  OTEL_ENABLED: 'false',
  OTEL_SERVICE_NAME: 'opshub-api', // the api's name: the worker must NOT take it
  OTEL_WORKER_SERVICE_NAME: 'opshub-worker',
  LOG_LEVEL: 'info',
  LOG_PRETTY: 'false',
  LOG_SQL: 'false',
  // Required by the shared schema for both roles; throwaway values, nothing outside this process verifies them.
  COOKIE_SECRET: 'test-cookie-secret-minimum-32-chars!!',
  CSRF_SECRET: 'test-csrf-secret-minimum-32-characters!',
});

process.chdir(mkdtempSync(join(tmpdir(), 'opshub-worker-conformance-')));
