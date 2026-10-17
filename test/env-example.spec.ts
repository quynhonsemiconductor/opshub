/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiEnvSchema, WorkerEnvSchema } from '@platform/config/env.schema';

/**
 * `.env.example` is the whole setup of a clean clone (`cp .env.example .env`), so it has to keep working against
 * the things it points at. Each of these drifted once or could:
 *
 *   - PORT was 3000 while apps/web/vite.config.ts proxied /v1 and /api/auth to :3001, so the SPA could not reach the
 *     API and every request came back 502 from the proxy;
 *   - SEED_ON_DEPLOY was absent, so `pnpm db:migrate` seeded no demo users and every test login was refused;
 *   - S3_FILES_BUCKET named a bucket but STORAGE_ENDPOINT was unset, which sends the SDK to real AWS S3;
 *   - MAIL_FROM_EMAIL was on a domain nobody here owns.
 *
 * This reads the files rather than importing the values, on purpose: what matters is that the FILES agree. The CI job
 * "local quickstart" is the end-to-end version (it boots the stack from this file); this one fails in seconds, and
 * names the variable.
 *
 * __dirname, not import.meta.dirname: this suite runs as CommonJS.
 */

const ROOT = join(__dirname, '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

/** `KEY=value` lines, as `process.loadEnvFile` reads them: no quoting in this file, split at the first `=`. */
function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** Every variable NAMED in the file, active or commented out (`# KEY=...`). */
function namedKeys(text: string): string[] {
  return [...text.matchAll(/^#?\s?([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
}

/** The `KEY=` prefixes of an npm script: how `pnpm start:dev[:worker]` blanks what its process must not see. */
function blankedBy(script: string): string[] {
  const keys: string[] = [];
  for (const word of script.split(/\s+/)) {
    const m = /^([A-Z][A-Z0-9_]*)=$/.exec(word);
    if (!m) break;
    keys.push(m[1]);
  }
  return keys;
}

const example = read('.env.example');
const env = parseEnv(example);
const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;
const compose = read('docker-compose.dev.yml');
const bootstrap = read('scripts/localstack/01-bootstrap.sh');
const vite = read('apps/web/vite.config.ts');

/** The process environment a script's own blanking leaves: .env.example with those keys set empty. */
function envAsSeenBy(script: string): Record<string, string> {
  const seen = { ...env };
  for (const key of blankedBy(scripts[script] ?? '')) seen[key] = '';
  return seen;
}

/** The host port a compose service publishes for a container port. */
function hostPort(container: string, containerPort: number): string | undefined {
  const service = new RegExp(
    `container_name: ${container}\\b[\\s\\S]*?(?=\\n  \\w[\\w-]*:\\n|\\nvolumes:|$)`,
  ).exec(compose)?.[0];
  return new RegExp(`'(\\d+):${containerPort}'`).exec(service ?? '')?.[1];
}

const portOf = (url: string | undefined) => new URL(url ?? 'http://invalid').port;

describe('.env.example boots the API and the worker from one file', () => {
  it('is accepted by the API schema, as `pnpm start:dev` runs it', () => {
    const result = ApiEnvSchema.safeParse(envAsSeenBy('start:dev'));
    expect(result.success, JSON.stringify(result.success ? '' : result.error.issues)).toBe(true);
  });

  it('is accepted by the worker schema, as `pnpm start:dev:worker` runs it', () => {
    const result = WorkerEnvSchema.safeParse(envAsSeenBy('start:dev:worker'));
    expect(result.success, JSON.stringify(result.success ? '' : result.error.issues)).toBe(true);
  });

  it('each start script blanks exactly the other process’s variables', () => {
    // The API-only keys the worker schema refuses, and the worker-only keys the API schema refuses.
    expect(blankedBy(scripts['start:dev:worker'] ?? '').sort()).toEqual(
      [
        'BETTER_AUTH_SECRET',
        'ENTRA_CLIENT_SECRET',
        'EDGE_CLIENT_IP_SECRET',
        'EDGE_CLIENT_IP_SECRET_PREVIOUS',
        'IDENTITY_TEST_LOGIN',
      ].sort(),
    );
    expect(blankedBy(scripts['start:dev'] ?? '').sort()).toEqual(
      ['GRAPH_CLIENT_CERTIFICATE', 'GRAPH_CLIENT_ID', 'GRAPH_FEDERATED_TOKEN_FILE'].sort(),
    );
  });

  it('names only variables the code knows (a typo here would be silently ignored)', () => {
    // Declared keys, read the way test/env-config-reachability.spec.ts reads them: the schema's own source.
    const schemaKeys = new Set(
      [
        ...read('libs/platform/src/config/env.schema.ts').matchAll(/^\s+([A-Z][A-Z0-9_]+):\s/gm),
      ].map((m) => m[1]),
    );
    // Read outside the schema: the migrator and its scripts, and platform-runtime's shutdown.
    const readElsewhere = new Set([
      'SEED_ON_DEPLOY',
      'DATABASE_MIGRATION_URL',
      'DATABASE_APP_PASSWORD',
      'DATABASE_WORKER_PASSWORD',
      'SHUTDOWN_TIMEOUT_MS',
      'SHUTDOWN_ENDPOINT_DELAY_MS',
    ]);
    const unknown = namedKeys(example).filter((k) => !schemaKeys.has(k) && !readElsewhere.has(k));
    expect(unknown).toEqual([]);
  });
});

describe('.env.example agrees with the dev tooling', () => {
  it('serves the API on the port the Vite proxy forwards to', () => {
    const targets = [...vite.matchAll(/target:\s*'http:\/\/localhost:(\d+)'/g)].map((m) => m[1]);
    expect(
      targets.length,
      'no proxy targets found in apps/web/vite.config.ts',
    ).toBeGreaterThanOrEqual(2);
    expect(new Set(targets).size, 'the /v1 and /api/auth proxies point at different ports').toBe(1);
    expect(env['PORT']).toBe(targets[0]);
  });

  it('points at the host ports docker-compose.dev.yml publishes', () => {
    expect(portOf(env['DATABASE_URL'])).toBe(hostPort('opshub-postgres', 5432));
    expect(portOf(env['REDIS_URL'])).toBe(hostPort('opshub-valkey', 6379));
    expect(portOf(env['STORAGE_ENDPOINT'])).toBe(hostPort('opshub-localstack', 4566));
    expect(portOf(env['AWS_ENDPOINT_URL'])).toBe(hostPort('opshub-localstack', 4566));
    expect(portOf(env['OTEL_EXPORTER_OTLP_ENDPOINT'])).toBe(hostPort('opshub-otel', 4318));
  });

  it('uses the bucket the LocalStack init hook creates and the compose healthcheck waits for', () => {
    const hook = /^BUCKET="([^"]+)"/m.exec(bootstrap)?.[1];
    expect(hook, 'BUCKET not found in scripts/localstack/01-bootstrap.sh').toBeDefined();
    expect(env['S3_FILES_BUCKET']).toBe(hook);
    expect(compose).toContain(`'--bucket', '${hook}'`);
  });

  it('sends uploads to LocalStack with static credentials, never to the real AWS S3', () => {
    expect(env['STORAGE_ENDPOINT'], 'unset STORAGE_ENDPOINT selects real AWS S3').toBeTruthy();
    expect(env['STORAGE_ACCESS_KEY_ID']).toBeTruthy();
    expect(env['STORAGE_SECRET_ACCESS_KEY']).toBeTruthy();
    expect(env['STORAGE_FORCE_PATH_STYLE']).toBe('true');
  });

  it('allows the browser origin the Vite server, LocalStack CORS and Playwright all use', () => {
    const port = /port:\s*(\d+)/.exec(vite)?.[1];
    expect(port, 'apps/web/vite.config.ts does not pin its port').toBeDefined();
    const origin = `http://localhost:${port}`;
    expect(vite).toContain('strictPort: true');
    expect(env['APP_URL']).toBe(origin);
    expect(env['CORS_ORIGINS']).toBe(origin);
    expect(bootstrap).toContain(`WEB_ORIGIN="${origin}"`);
    expect(read('apps/web/playwright.config.ts')).toContain(`baseURL: '${origin}'`);
  });
});

describe('.env.example signs a developer in with no further setup', () => {
  it('loads the demo users and enables the test login', () => {
    expect(env['NODE_ENV']).toBe('development');
    expect(env['SEED_ON_DEPLOY'], 'db:migrate would seed no demo users').toBe('true');
    expect(env['IDENTITY_TEST_LOGIN']).toBe('enabled');
  });

  it('seeds the user the README tells people to sign in as', () => {
    expect(read('db/seed.ts')).toContain("email: 'admin@opshub.local'");
  });

  it('labels every log line and metric as a local run, not develop or production', () => {
    expect(env['DEPLOYMENT_ENV']).toBe('local');
  });
});

describe('.env.example holds no real secret and no foreign sender', () => {
  it.each(['BETTER_AUTH_SECRET', 'COOKIE_SECRET', 'CSRF_SECRET'])(
    '%s is an obvious local placeholder',
    (key) => {
      expect(env[key]).toMatch(/^local-dev-only-/);
      expect(env[key]?.length).toBeGreaterThanOrEqual(32);
    },
  );

  it.each([
    'ENTRA_TENANT_ID',
    'ENTRA_CLIENT_ID',
    'ENTRA_CLIENT_SECRET',
    'EDGE_CLIENT_IP_SECRET',
    'EDGE_CLIENT_IP_SECRET_PREVIOUS',
    'GRAPH_CLIENT_ID',
    'GRAPH_CLIENT_CERTIFICATE',
    'RESEND_API_KEY',
  ])('%s is left empty: a developer supplies their own', (key) => {
    expect(env[key]).toBe('');
  });

  it('sends mail from a domain this organisation owns (and, with the dev provider, sends none)', () => {
    expect(env['EMAIL_PROVIDER']).toBe('dev');
    expect(env['MAIL_FROM_EMAIL']).toMatch(/@qnsc\.vn$/);
  });
});

describe('the README and the "local quickstart" CI job run the same commands', () => {
  // The job is only a guarantee about the README if it runs what the README says. These are the commands a clean clone
  // runs; changing one in either place without the other fails here.
  const COMMANDS = [
    'cp .env.example .env',
    'docker compose -f docker-compose.dev.yml up -d --wait',
    'pnpm db:migrate',
    'pnpm start:dev',
    'pnpm start:dev:worker',
    'pnpm dev:web',
  ];
  const readme = read('README.md');
  const workflow = read('.github/workflows/web-ci.yml');

  it.each(COMMANDS)('`%s` is in both', (command) => {
    expect(readme, `README.md "Local stack" lacks: ${command}`).toContain(command);
    expect(workflow, `web-ci.yml "local quickstart" lacks: ${command}`).toContain(command);
  });

  it('the job gates the PR: it is a dependency of `Web CI required`', () => {
    expect(workflow).toMatch(/needs: \[changes, quality, test, build, e2e, quickstart\]/);
  });
});
