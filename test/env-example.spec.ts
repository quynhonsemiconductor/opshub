/// <reference types="node" />
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
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
const composeDoc = parseYaml(compose, { merge: true }) as {
  services: Record<string, { ports?: unknown[] }>;
};
const bootstrap = read('scripts/localstack/01-bootstrap.sh');
const vite = read('apps/web/vite.config.ts');

/** The process environment a script's own blanking leaves: .env.example with those keys set empty. */
function envAsSeenBy(script: string): Record<string, string> {
  const seen = { ...env };
  for (const key of blankedBy(scripts[script] ?? '')) seen[key] = '';
  return seen;
}

/**
 * Every `ports:` entry of a compose service, as `host_ip:published:target`, parsed by a real YAML parser so the block,
 * flow and quoted forms all read the same. Short syntax stays as written (a bare `5432` stays bare). Long syntax folds its
 * keys into that shape, with an empty host_ip when none is given, so the loopback check fails on it.
 */
function portEntries(service: string): string[] {
  const ports = composeDoc.services[service]?.ports ?? [];
  return ports.map((port) => {
    if (typeof port !== 'object' || port === null) return String(port);
    const long = port as { host_ip?: unknown; published?: unknown; target?: unknown };
    const field = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
    return [field(long.host_ip), field(long.published), field(long.target)].join(':');
  });
}

/** The host port a compose service publishes for a container port, as `127.0.0.1:${VARIABLE:-default}:containerPort`. */
function publishedPort(
  service: string,
  containerPort: number,
): { variable: string; port: string } | undefined {
  const m = portEntries(service)
    .map((entry) =>
      new RegExp(`^127\\.0\\.0\\.1:\\$\\{(\\w+):-(\\d+)\\}:${containerPort}$`).exec(entry),
    )
    .find(Boolean);
  return m ? { variable: m[1] ?? '', port: m[2] ?? '' } : undefined;
}

const portOf = (url: string | undefined) => new URL(url ?? 'http://invalid').port;

/** Every service image a GitHub workflow runs, by job, parsed the same way as the compose file. */
function workflowServiceImages(file: string): string[] {
  const doc = parseYaml(read(file)) as {
    jobs?: Record<string, { services?: Record<string, { image?: string }> }>;
  };
  return Object.values(doc.jobs ?? {}).flatMap((job) =>
    Object.values(job.services ?? {}).flatMap((svc) => (svc.image ? [svc.image] : [])),
  );
}

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
      // Read by docker-compose.dev.yml for its host ports and project name, never by the app.
      'COMPOSE_PROJECT_NAME',
      'POSTGRES_HOST_PORT',
      'VALKEY_HOST_PORT',
      'LOCALSTACK_HOST_PORT',
      'OTEL_OTLP_HOST_PORT',
      'OTEL_METRICS_HOST_PORT',
      'WEB_DEV_PORT',
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
    // Both proxies use one origin, built from PORT in the root .env (default 3001), which .env.example must set.
    const proxies = (vite.match(/target: apiOrigin/g) ?? []).length;
    expect(
      proxies,
      'the /v1 and /api/auth proxies do not both use apiOrigin',
    ).toBeGreaterThanOrEqual(2);
    const fallback = /dotenv\.PORT \|\| (\d+)/.exec(vite)?.[1];
    expect(fallback, 'no PORT fallback in apps/web/vite.config.ts').toBeDefined();
    expect(env['PORT']).toBe(fallback);
  });

  it('points at the host ports docker-compose.dev.yml publishes, through the .env variable that sets each', () => {
    const postgres = publishedPort('postgres', 5432);
    const valkey = publishedPort('valkey', 6379);
    const localstack = publishedPort('localstack', 4566);
    const otel = publishedPort('otel', 4318);
    for (const published of [postgres, valkey, localstack, otel]) {
      expect(published, 'a compose service publishes no 127.0.0.1-bound host port').toBeDefined();
      expect(env[published?.variable ?? '']).toBe(published?.port);
    }
    expect(portOf(env['DATABASE_URL'])).toBe(env['POSTGRES_HOST_PORT']);
    expect(portOf(env['VALKEY_URL'])).toBe(env['VALKEY_HOST_PORT']);
    expect(portOf(env['STORAGE_ENDPOINT'])).toBe(env['LOCALSTACK_HOST_PORT']);
    expect(portOf(env['AWS_ENDPOINT_URL'])).toBe(env['LOCALSTACK_HOST_PORT']);
    expect(portOf(env['OTEL_EXPORTER_OTLP_ENDPOINT'])).toBe(env['OTEL_OTLP_HOST_PORT']);
    expect(publishedPort('otel', 8889)?.variable).toBe('OTEL_METRICS_HOST_PORT');
  });

  it('publishes every host port on loopback only, whatever the syntax', () => {
    const services = Object.keys(composeDoc.services);
    const published = services.flatMap((service) =>
      portEntries(service).map((e) => `${service}: ${e}`),
    );
    expect(published.length).toBeGreaterThan(0);
    expect(published.filter((p) => !/: 127\.0\.0\.1:/.test(p))).toEqual([]);
  });

  it('gives every compose port variable a default that matches .env.example', () => {
    const interpolated = [...compose.matchAll(/\$\{(\w+):-(\d+)\}/g)];
    expect(interpolated.length).toBeGreaterThanOrEqual(5);
    for (const [, variable, value] of interpolated) {
      expect(env[variable ?? ''], `${variable} is missing from .env.example`).toBe(value);
    }
  });

  it('names no fixed container, so a second copy with its own COMPOSE_PROJECT_NAME can run beside this one', () => {
    expect(compose).not.toContain('container_name:');
    expect(compose).toMatch(/^name: opshub$/m);
  });

  it('pins the images to the production majors: RDS Postgres 17, ElastiCache Valkey 7.2', () => {
    expect(compose).toMatch(/image: postgres:17\.\d+-alpine/);
    expect(compose).toMatch(/image: valkey\/valkey:7\.2\.\d+-alpine/);
  });

  it('names no fixed container anywhere a developer or CI reads, so a second project can run beside this one', () => {
    const scripts = readdirSync(join(ROOT, 'scripts'), { recursive: true }) as string[];
    // README.md is not in this list: its upgrade note names the old containers on purpose, to tell people to remove them.
    const files = [
      '.env.example',
      '.github/workflows/web-ci.yml',
      '.github/workflows/backend-ci.yml',
      ...scripts
        .filter((f) => statSync(join(ROOT, 'scripts', f)).isFile())
        .map((f) => `scripts/${f}`),
    ];
    const named = /\bopshub-(postgres|valkey|localstack|otel)\b/;
    for (const file of files)
      expect(read(file), `${file} names a fixed container`).not.toMatch(named);
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
    const port = /WEB_DEV_PORT\)\s*\|\|\s*(\d+)/.exec(vite)?.[1];
    expect(port, 'apps/web/vite.config.ts does not pin its port').toBeDefined();
    const origin = `http://localhost:${port}`;
    expect(vite).toContain('strictPort: true');
    expect(env['APP_URL']).toBe(origin);
    expect(env['CORS_ORIGINS']).toBe(origin);
    expect(bootstrap).toContain(`WEB_ORIGIN="\${WEB_ORIGIN:-${origin}}"`);
    expect(compose).toContain(`WEB_ORIGIN: http://localhost:\${WEB_DEV_PORT:-${port}}`);
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

describe('.env.example uses the current cache name', () => {
  it('sets VALKEY_URL and not the deprecated REDIS_URL', () => {
    expect(env['VALKEY_URL']).toBeTruthy();
    expect(Object.keys(env)).not.toContain('REDIS_URL');
  });
});

describe('CI runs the same images as the dev stack', () => {
  // A service image in CI that drifts from docker-compose.dev.yml tests a different Postgres or Valkey than the one a
  // developer and production run. Same repository, same tag.
  const composeImages = Object.values(composeDoc.services).flatMap(
    (svc) => (svc as { image?: string }).image ?? [],
  );
  it.each(['.github/workflows/backend-ci.yml', '.github/workflows/web-ci.yml'])(
    '%s uses the compose tag for every image both run',
    (file) => {
      const repoOf = (image: string) => image.split(':')[0];
      const shared = workflowServiceImages(file).filter((image) =>
        composeImages.some((c) => repoOf(c) === repoOf(image)),
      );
      expect(shared.length, `${file} runs no service the compose file also runs`).toBeGreaterThan(
        0,
      );
      for (const image of shared) {
        expect(composeImages, `${file} runs ${image}, which the compose file does not`).toContain(
          image,
        );
      }
    },
  );
});

/**
 * The host ports every product owns, as published in the "Local development" page of .github. Each product's compose
 * defaults and .env.example must equal this block, so the three stacks run side by side without a clash.
 */
const PORT_BLOCK = {
  POSTGRES_HOST_PORT: '5410',
  VALKEY_HOST_PORT: '6310',
  LOCALSTACK_HOST_PORT: '4610',
  OTEL_OTLP_HOST_PORT: '4410',
  OTEL_METRICS_HOST_PORT: '8410',
  WEB_DEV_PORT: '5174',
  PORT: '3001',
} as const;

describe('the port block is the one the .github table publishes', () => {
  it.each(Object.entries(PORT_BLOCK))('%s defaults to %s in .env.example', (key, value) => {
    expect(env[key]).toBe(value);
  });

  it('the compose defaults match the same block', () => {
    for (const [key, value] of Object.entries(PORT_BLOCK)) {
      if (key === 'PORT') continue;
      expect(compose).toContain('${' + key + ':-' + value + '}');
    }
  });
});
