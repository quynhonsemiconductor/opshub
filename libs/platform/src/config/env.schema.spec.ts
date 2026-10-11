import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import type { ApiConfigService, WorkerConfigService } from './app-config.service';
import {
  ApiEnvSchema,
  ApiEnvSchema as EnvSchema,
  EnvSchema as RoleAwareEnvSchema,
  WorkerEnvSchema,
  setProcessRole,
} from './env.schema';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

/** Minimum that satisfies the rest of the schema, so each block tests one thing. */
function env(overrides: Record<string, string | undefined> = {}) {
  return {
    DATABASE_URL: 'postgres://u:p@localhost:5432/opshub',
    JWT_PRIVATE_KEY: privatePem,
    COOKIE_SECRET: 'y'.repeat(32),
    CSRF_SECRET: 'z'.repeat(32),
    ...overrides,
  };
}

describe('EnvSchema — JWT key pair', () => {
  // The point of the derivation: a mismatched pair is the one failure a key pair cannot
  // otherwise have (signing succeeds, every verification rejects) and nothing upstream
  // can detect it, because both halves are individually valid.
  it('derives JWT_PUBLIC_KEY from JWT_PRIVATE_KEY when it is not supplied', () => {
    const result = EnvSchema.safeParse(env());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.JWT_PUBLIC_KEY).toBe(publicPem);
  });

  it('derives a key that actually matches the private half', () => {
    const result = EnvSchema.safeParse(env());
    if (!result.success) throw new Error('expected parse to succeed');
    const fromPrivate = createPublicKey(result.data.JWT_PRIVATE_KEY)
      .export({ type: 'spki', format: 'pem' })
      .toString();
    expect(result.data.JWT_PUBLIC_KEY).toBe(fromPrivate);
  });

  it('honours an explicitly supplied JWT_PUBLIC_KEY', () => {
    const result = EnvSchema.safeParse(env({ JWT_PUBLIC_KEY: publicPem }));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.JWT_PUBLIC_KEY).toBe(publicPem);
  });

  it('accepts a base64-encoded private key and still derives from it', () => {
    const result = EnvSchema.safeParse(
      env({ JWT_PRIVATE_KEY: Buffer.from(privatePem).toString('base64') }),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.JWT_PUBLIC_KEY).toBe(publicPem);
  });

  // A public key pasted into the private slot is well-formed PEM, so it passes the
  // field-level refine and would otherwise fail much later, at the first sign().
  it('fails naming JWT_PRIVATE_KEY when a public key is supplied as the private one', () => {
    const result = EnvSchema.safeParse(env({ JWT_PRIVATE_KEY: publicPem }));
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) => i.path.includes('JWT_PRIVATE_KEY'));
    expect(issue?.message).toMatch(/not a PRIVATE key/);
  });

  // ES256 is P-256 specifically. Another curve signs fine and every verifier rejects
  // the result, which presents as a broken deploy with no obvious cause.
  it('rejects an EC key on the wrong curve', () => {
    const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    const result = EnvSchema.safeParse(env({ JWT_PRIVATE_KEY: p384 }));
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) => i.path.includes('JWT_PRIVATE_KEY'));
    expect(issue?.message).toMatch(/must be an EC P-256 key for ES256/);
  });

  it('rejects an RSA key', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    expect(EnvSchema.safeParse(env({ JWT_PRIVATE_KEY: rsa })).success).toBe(false);
  });

  it('still rejects a JWT_PRIVATE_KEY that is not PEM at all', () => {
    expect(EnvSchema.safeParse(env({ JWT_PRIVATE_KEY: 'not-a-key' })).success).toBe(false);
  });
});

describe('EnvSchema — database credentials', () => {
  const parts = {
    DATABASE_HOST: 'db.internal',
    DATABASE_PORT: '5432',
    DATABASE_NAME: 'opshub',
    DATABASE_USER: 'app_admin',
    DATABASE_PASSWORD: 'pw',
  };

  it('accepts a complete DATABASE_URL', () => {
    expect(EnvSchema.safeParse(env()).success).toBe(true);
  });

  it('accepts the discrete parts with no DATABASE_URL — the deployed path', () => {
    const result = EnvSchema.safeParse({ ...env({ DATABASE_URL: undefined }), ...parts });
    expect(result.success).toBe(true);
    if (!result.success) return;
    // Coerced, so db/database-url.ts receives a number here and a string from raw env.
    expect(result.data.DATABASE_PORT).toBe(5432);
    expect(result.data.DATABASE_SSLMODE).toBe('require');
  });

  // Boot-time failure is the whole point: a stale or half-wired credential that passes
  // startup and dies on the first query presents as a healthy deploy, then 28P01.
  it('rejects neither form being complete, naming what is missing', () => {
    const result = EnvSchema.safeParse(env({ DATABASE_URL: undefined }));
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) => i.path.includes('DATABASE_URL'));
    expect(issue?.message).toMatch(/DATABASE_HOST.*DATABASE_PASSWORD/s);
  });

  it.each([
    'DATABASE_HOST',
    'DATABASE_PORT',
    'DATABASE_NAME',
    'DATABASE_USER',
    'DATABASE_PASSWORD',
  ])('rejects the parts form with %s missing, and says so', (key) => {
    const result = EnvSchema.safeParse({
      ...env({ DATABASE_URL: undefined }),
      ...parts,
      [key]: undefined,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) => i.path.includes('DATABASE_URL'));
    expect(issue?.message).toContain(key);
  });

  it('a complete URL wins, so a stray part cannot make the config invalid', () => {
    const result = EnvSchema.safeParse({ ...env(), DATABASE_HOST: 'db.internal' });
    expect(result.success).toBe(true);
  });
});

describe('EnvSchema — cache URL alias', () => {
  // Infra injects VALKEY_URL; every caller reads REDIS_URL. Kept here because the
  // normalisation now shares a transform with the JWT derivation, so a change to one
  // can silently drop the other.
  it('resolves VALKEY_URL into REDIS_URL', () => {
    const result = EnvSchema.safeParse(env({ VALKEY_URL: 'rediss://cache:6379' }));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.REDIS_URL).toBe('rediss://cache:6379');
  });

  it('leaves an explicit REDIS_URL alone when no alias is set', () => {
    const result = EnvSchema.safeParse(env({ REDIS_URL: 'redis://localhost:6379' }));
    if (!result.success) throw new Error('expected parse to succeed');
    expect(result.data.REDIS_URL).toBe('redis://localhost:6379');
  });

  it('prefers the infra alias over an explicit REDIS_URL', () => {
    const result = EnvSchema.safeParse(
      env({ REDIS_URL: 'redis://localhost:6379', VALKEY_URL: 'rediss://cache:6379' }),
    );
    if (!result.success) throw new Error('expected parse to succeed');
    expect(result.data.REDIS_URL).toBe('rediss://cache:6379');
  });
});

describe('EnvSchema — object storage backend', () => {
  // Unset is the default and must stay behaviour-identical: AWS S3 via the task role.
  it('accepts no STORAGE_* at all', () => {
    expect(EnvSchema.safeParse(env()).success).toBe(true);
  });

  it('accepts a complete R2-style configuration', () => {
    const result = EnvSchema.safeParse(
      env({
        STORAGE_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
        STORAGE_ACCESS_KEY_ID: 'id',
        STORAGE_SECRET_ACCESS_KEY: 'secret',
        STORAGE_FORCE_PATH_STYLE: 'true',
      }),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.STORAGE_FORCE_PATH_STYLE).toBe(true);
  });

  // Half a pair silently omits `credentials` from the S3Client, which for AWS quietly
  // works via the task role and for R2 fails at the first request.
  it.each([
    ['STORAGE_ACCESS_KEY_ID', 'STORAGE_SECRET_ACCESS_KEY'],
    ['STORAGE_SECRET_ACCESS_KEY', 'STORAGE_ACCESS_KEY_ID'],
  ])('rejects %s without %s', (present, missing) => {
    const result = EnvSchema.safeParse(env({ [present]: 'x' }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.path.includes(missing))).toBe(true);
  });

  // An S3-compatible endpoint has no instance role to fall back on.
  it('rejects STORAGE_ENDPOINT with no credentials', () => {
    const result = EnvSchema.safeParse(
      env({ STORAGE_ENDPOINT: 'https://acct.r2.cloudflarestorage.com' }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) => i.path.includes('STORAGE_ACCESS_KEY_ID'));
    expect(issue?.message).toMatch(/no task role to fall back to/);
  });

  it('rejects a STORAGE_ENDPOINT that is not a URL', () => {
    expect(EnvSchema.safeParse(env({ STORAGE_ENDPOINT: 'r2.example' })).success).toBe(false);
  });

  it('allows credentials WITHOUT an endpoint — static keys against AWS S3', () => {
    // Legitimate: a task running outside AWS, or local development against real S3.
    const result = EnvSchema.safeParse(
      env({ STORAGE_ACCESS_KEY_ID: 'id', STORAGE_SECRET_ACCESS_KEY: 'secret' }),
    );
    expect(result.success).toBe(true);
  });
});

/**
 * The DEFAULT rate limit is configurable DOWN, never up in production.
 *
 * The knob exists because the browser E2E suite drives fifty specs through four seeded identities inside
 * three minutes and crossed 200/min — in CI, after spreading the load over those four seats already fixed
 * it locally. That is a test-environment problem, and the accommodation must not become a dial somebody
 * can turn in production: these three cases are what make the docblock's promise enforceable.
 */
describe('EnvSchema — the DEFAULT rate-limit ceiling', () => {
  it('defaults to the shipped 200 per minute', () => {
    const result = EnvSchema.safeParse(env());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.RATE_LIMIT_DEFAULT_LIMIT).toBe(200);
  });

  it('lets a test environment raise it', () => {
    const result = EnvSchema.safeParse(env({ NODE_ENV: 'test', RATE_LIMIT_DEFAULT_LIMIT: '5000' }));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.RATE_LIMIT_DEFAULT_LIMIT).toBe(5000);
  });

  it('REFUSES to raise it in production, and says why', () => {
    const result = EnvSchema.safeParse(
      env({ NODE_ENV: 'production', RATE_LIMIT_DEFAULT_LIMIT: '5000' }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.message).toMatch(/cannot exceed 200 when NODE_ENV=production/);
  });

  it('allows LOWERING it in production, because that is not a weakening', () => {
    const result = EnvSchema.safeParse(
      env({ NODE_ENV: 'production', RATE_LIMIT_DEFAULT_LIMIT: '50' }),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.RATE_LIMIT_DEFAULT_LIMIT).toBe(50);
  });
});

describe('EnvSchema — email sender', () => {
  /*
   * `MAIL_FROM_EMAIL` used to default to `no-reply@opshub.app`, so a deployment configured with a real
   * provider and no sender booted happily and sent from a domain it may not own — which fails SPF and
   * DKIM at the recipient. That is silent non-delivery, or delivery to spam, and neither shows up in
   * our logs. The sibling repo added the same refusal after finding both of its environments in
   * exactly that state.
   */
  it('refuses to boot a non-dev provider with no sender', () => {
    const result = EnvSchema.safeParse(env({ EMAIL_PROVIDER: 'resend' }));

    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) => i.path[0] === 'MAIL_FROM_EMAIL');
    expect(issue, 'the refusal did not name the variable at fault').toBeDefined();
    // The message has to say what to do about it, not just that something is wrong.
    expect(issue!.message).toContain('SPF');
  });

  it('accepts a non-dev provider once a sender is set', () => {
    const result = EnvSchema.safeParse(
      env({ EMAIL_PROVIDER: 'resend', MAIL_FROM_EMAIL: 'ops@example.test' }),
    );
    expect(result.success, JSON.stringify(result.success ? {} : result.error.issues)).toBe(true);
  });

  it('leaves the dev provider alone, because it has nothing to send from', () => {
    // `DevEmailProvider` logs instead of sending. Requiring a sender there would make every
    // developer and CI environment configure a mail identity for mail that never leaves the process.
    const result = EnvSchema.safeParse(env());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.EMAIL_PROVIDER).toBe('dev');
    expect(result.data.MAIL_FROM_EMAIL).toBeUndefined();
  });

  it('does not invent a sender when one is absent', () => {
    // The default is what made the misconfiguration silent, so its absence is the assertion.
    const result = EnvSchema.safeParse(env());
    if (!result.success) throw new Error('expected parse to succeed');
    expect(result.data.MAIL_FROM_EMAIL).not.toBe('no-reply@opshub.app');
  });
});

describe('role-specific schemas — the API and the worker hold different credentials', () => {
  const GRAPH = {
    GRAPH_CLIENT_ID: '22222222-2222-4222-8222-222222222222',
    GRAPH_CLIENT_CERTIFICATE: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----',
    GRAPH_FEDERATED_TOKEN_FILE: '/var/run/secrets/tokens/graph',
  };

  it('the API accepts the sign-in secret', () => {
    const result = ApiEnvSchema.safeParse(env({ ENTRA_CLIENT_SECRET: 'sign-in-secret' }));
    expect(result.success).toBe(true);
    expect(result.data?.ENTRA_CLIENT_SECRET).toBe('sign-in-secret');
  });

  it.each(Object.keys(GRAPH))('the API REFUSES TO START with %s set', (name) => {
    const result = ApiEnvSchema.safeParse(env({ [name]: GRAPH[name as keyof typeof GRAPH] }));

    expect(result.success).toBe(false);
    const issue = result.error?.issues.find((i) => i.path[0] === name);
    expect(issue?.message).toMatch(/must not be set on the API/);
    // The value never appears in the message.
    expect(JSON.stringify(result.error?.issues)).not.toContain(GRAPH[name as keyof typeof GRAPH]);
  });

  it('the API treats an EMPTY Graph variable as unset (a blank chart value is not a credential)', () => {
    expect(ApiEnvSchema.safeParse(env({ GRAPH_CLIENT_ID: '' })).success).toBe(true);
  });

  it('the worker accepts the Graph variables', () => {
    const result = WorkerEnvSchema.safeParse(env(GRAPH));
    expect(result.success).toBe(true);
    expect(result.data?.GRAPH_CLIENT_ID).toBe(GRAPH.GRAPH_CLIENT_ID);
  });

  it('the worker REFUSES TO START with ENTRA_CLIENT_SECRET set', () => {
    const result = WorkerEnvSchema.safeParse(env({ ENTRA_CLIENT_SECRET: 'sign-in-secret' }));

    expect(result.success).toBe(false);
    expect(result.error?.issues.find((i) => i.path[0] === 'ENTRA_CLIENT_SECRET')?.message).toMatch(
      /must not be set on the worker/,
    );
  });

  it('both roles keep the shared rules (a worker still needs a database)', () => {
    expect(WorkerEnvSchema.safeParse({ JWT_PRIVATE_KEY: privatePem }).success).toBe(false);
    expect(WorkerEnvSchema.safeParse(env()).success).toBe(true);
  });

  it('a process that has not declared its role does not get to guess one', () => {
    // Module state: this runs before any setProcessRole in this file's process.
    expect(() => RoleAwareEnvSchema.safeParse(env())).toThrow(/process role is not set/);
  });

  it('validates with the schema of the role the entry point declared', () => {
    setProcessRole('api');
    expect(RoleAwareEnvSchema.safeParse(env(GRAPH)).success).toBe(false);
    setProcessRole('worker');
    expect(RoleAwareEnvSchema.safeParse(env(GRAPH)).success).toBe(true);
    expect(RoleAwareEnvSchema.safeParse(env({ ENTRA_CLIENT_SECRET: 'x' })).success).toBe(false);
  });

  it('is enforced by the TYPES too: the API cannot read a Graph variable, the worker cannot read the sign-in secret', () => {
    // Compile-time assertions; the `@ts-expect-error` lines fail `tsc` if the boundary is ever widened.
    const never = () => {
      const api = {} as ApiConfigService;
      const worker = {} as WorkerConfigService;
      // @ts-expect-error GRAPH_CLIENT_ID is not an API variable
      api.get('GRAPH_CLIENT_ID');
      // @ts-expect-error ENTRA_CLIENT_SECRET is not a worker variable
      worker.get('ENTRA_CLIENT_SECRET');
      api.get('ENTRA_CLIENT_SECRET');
      worker.get('GRAPH_CLIENT_ID');
    };
    expect(typeof never).toBe('function');
  });
});
