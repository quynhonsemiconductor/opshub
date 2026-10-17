import { describe, it, expect, vi } from 'vitest';
import type { ApiConfigService, AppConfigService, WorkerConfigService } from './app-config.service';
import {
  ApiEnvSchema,
  ApiEnvSchema as EnvSchema,
  EnvSchema as RoleAwareEnvSchema,
  WorkerEnvSchema,
} from './env.schema';
import { resetProcessRoleForTests, setProcessRole } from './process-role';

/** Minimum that satisfies the rest of the schema, so each block tests one thing. */
function env(overrides: Record<string, string | undefined> = {}) {
  return {
    DATABASE_URL: 'postgres://u:p@localhost:5432/opshub',
    BETTER_AUTH_SECRET: 'b'.repeat(32),
    COOKIE_SECRET: 'y'.repeat(32),
    CSRF_SECRET: 'z'.repeat(32),
    ...overrides,
  };
}

/** The same, as the WORKER sees it: it has no sign-in secret (its schema refuses one). */
function workerEnv(overrides: Record<string, string | undefined> = {}) {
  const base: Record<string, string | undefined> = env();
  delete base['BETTER_AUTH_SECRET'];
  return { ...base, ...overrides };
}

describe('EnvSchema — identity 8 sign-in', () => {
  const production = {
    NODE_ENV: 'production',
    APP_URL: 'https://opshub.example.test',
    ENTRA_TENANT_ID: '11111111-1111-4111-8111-111111111111',
    ENTRA_CLIENT_ID: '22222222-2222-4222-8222-222222222222',
    ENTRA_CLIENT_SECRET: 'client-secret',
    EDGE_CLIENT_IP_SECRET: 'e'.repeat(40),
  };

  it('requires BETTER_AUTH_SECRET, 32+ characters', () => {
    expect(EnvSchema.safeParse(env({ BETTER_AUTH_SECRET: undefined })).success).toBe(false);
    expect(EnvSchema.safeParse(env({ BETTER_AUTH_SECRET: 'short' })).success).toBe(false);
    expect(EnvSchema.safeParse(env()).success).toBe(true);
  });

  it('the v7 variables are gone: setting them is harmless but they are not in the parsed config', () => {
    const result = EnvSchema.safeParse(
      env({
        JWT_PRIVATE_KEY: 'x',
        BFF_SESSION_TTL_SECONDS: '10',
        ENTRA_REDIRECT_URI: 'https://x.test',
      }),
    );
    if (!result.success) throw new Error('expected parse to succeed');
    expect(Object.keys(result.data)).not.toEqual(
      expect.arrayContaining(['JWT_PRIVATE_KEY', 'BFF_SESSION_TTL_SECONDS', 'ENTRA_REDIRECT_URI']),
    );
  });

  it('development and CI may leave Entra unset (test-login signs in)', () => {
    expect(EnvSchema.safeParse(env()).success).toBe(true);
    expect(
      EnvSchema.safeParse(env({ NODE_ENV: 'test', IDENTITY_TEST_LOGIN: 'enabled' })).success,
    ).toBe(true);
  });

  it('production accepts a complete configuration', () => {
    expect(EnvSchema.safeParse(env(production)).success).toBe(true);
  });

  it.each(['ENTRA_TENANT_ID', 'ENTRA_CLIENT_ID', 'ENTRA_CLIENT_SECRET', 'EDGE_CLIENT_IP_SECRET'])(
    'production refuses a boot without %s, naming it (an empty string counts as unset)',
    (key) => {
      for (const value of [undefined, '']) {
        const result = EnvSchema.safeParse(env({ ...production, [key]: value }));
        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.error.issues.some((i) => i.path.includes(key))).toBe(true);
      }
    },
  );

  it('production refuses IDENTITY_TEST_LOGIN (a passwordless sign-in), before identity itself would', () => {
    const result = EnvSchema.safeParse(env({ ...production, IDENTITY_TEST_LOGIN: 'enabled' }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.path.includes('IDENTITY_TEST_LOGIN'))).toBe(true);
  });

  it('production refuses a non-https APP_URL: it is the origin Entra redirects to and that owns the cookie', () => {
    const result = EnvSchema.safeParse(
      env({ ...production, APP_URL: 'http://opshub.example.test' }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.path.includes('APP_URL'))).toBe(true);
  });

  it('IDENTITY_TEST_LOGIN accepts only "enabled"', () => {
    expect(EnvSchema.safeParse(env({ IDENTITY_TEST_LOGIN: 'yes' })).success).toBe(false);
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

describe('EnvSchema — cache URL: VALKEY_URL, with REDIS_URL as a deprecated alias', () => {
  // Every reader uses get('VALKEY_URL'). REDIS_URL survives one more release so an existing .env keeps booting; the
  // normalisation shares a transform with other derivations, so a change to one can silently drop the other.
  it('reads VALKEY_URL', () => {
    const result = EnvSchema.safeParse(env({ VALKEY_URL: 'rediss://cache:6379' }));
    if (!result.success) throw new Error('expected parse to succeed');
    expect(result.data.VALKEY_URL).toBe('rediss://cache:6379');
  });

  it('folds the deprecated REDIS_URL into VALKEY_URL when it is the only one set, and says it is deprecated (once)', () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const result = EnvSchema.safeParse(env({ REDIS_URL: 'redis://localhost:6379' }));
    EnvSchema.safeParse(env({ REDIS_URL: 'redis://localhost:6379' }));
    if (!result.success) throw new Error('expected parse to succeed');
    expect(result.data.VALKEY_URL).toBe('redis://localhost:6379');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('REDIS_URL is deprecated'),
      expect.objectContaining({ code: 'OPSHUB_REDIS_URL' }),
    );
    warn.mockRestore();
  });

  it('does not warn when VALKEY_URL is set, even alongside REDIS_URL', () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    EnvSchema.safeParse(env({ VALKEY_URL: 'rediss://cache:6379', REDIS_URL: 'redis://x:6379' }));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('prefers VALKEY_URL over REDIS_URL when both are set', () => {
    const result = EnvSchema.safeParse(
      env({ REDIS_URL: 'redis://localhost:6379', VALKEY_URL: 'rediss://cache:6379' }),
    );
    if (!result.success) throw new Error('expected parse to succeed');
    expect(result.data.VALKEY_URL).toBe('rediss://cache:6379');
  });

  it('leaves the cache unset when neither is set', () => {
    const result = EnvSchema.safeParse(env());
    if (!result.success) throw new Error('expected parse to succeed');
    expect(result.data.VALKEY_URL).toBeUndefined();
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
      env({
        NODE_ENV: 'production',
        RATE_LIMIT_DEFAULT_LIMIT: '50',
        APP_URL: 'https://opshub.example.test',
        ENTRA_TENANT_ID: '11111111-1111-4111-8111-111111111111',
        ENTRA_CLIENT_ID: '22222222-2222-4222-8222-222222222222',
        ENTRA_CLIENT_SECRET: 'client-secret',
        EDGE_CLIENT_IP_SECRET: 'e'.repeat(40),
      }),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.RATE_LIMIT_DEFAULT_LIMIT).toBe(50);
  });
});

describe('EnvSchema — WEBHOOK_DELIVERY_MAX_AGE_HOURS', () => {
  it('defaults to 24 hours', () => {
    const result = EnvSchema.safeParse(env());
    expect(result.success && result.data.WEBHOOK_DELIVERY_MAX_AGE_HOURS).toBe(24);
  });

  it('takes a whole number of hours from the environment', () => {
    const result = EnvSchema.safeParse(env({ WEBHOOK_DELIVERY_MAX_AGE_HOURS: '72' }));
    expect(result.success && result.data.WEBHOOK_DELIVERY_MAX_AGE_HOURS).toBe(72);
  });

  it.each(['0', '-1', '1.5', 'soon'])(
    'refuses %s: an age of zero would expire every delivery before it is sent',
    (value) => {
      const result = EnvSchema.safeParse(env({ WEBHOOK_DELIVERY_MAX_AGE_HOURS: value }));
      expect(result.success).toBe(false);
    },
  );
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
    const result = WorkerEnvSchema.safeParse(workerEnv(GRAPH));
    expect(result.success).toBe(true);
    expect(result.data?.GRAPH_CLIENT_ID).toBe(GRAPH.GRAPH_CLIENT_ID);
  });

  it('the worker REFUSES TO START with ENTRA_CLIENT_SECRET set', () => {
    const result = WorkerEnvSchema.safeParse(workerEnv({ ENTRA_CLIENT_SECRET: 'sign-in-secret' }));

    expect(result.success).toBe(false);
    expect(result.error?.issues.find((i) => i.path[0] === 'ENTRA_CLIENT_SECRET')?.message).toMatch(
      /must not be set on the worker/,
    );
  });

  it('the worker REFUSES TO START with BETTER_AUTH_SECRET set: a worker holding it could forge a session cookie', () => {
    const result = WorkerEnvSchema.safeParse(workerEnv({ BETTER_AUTH_SECRET: 'b'.repeat(32) }));

    expect(result.success).toBe(false);
    const issue = result.error?.issues.find((i) => i.path[0] === 'BETTER_AUTH_SECRET');
    expect(issue?.message).toMatch(/must not be set on the worker/);
    expect(JSON.stringify(result.error?.issues)).not.toContain('b'.repeat(32));
  });

  it('the worker REFUSES TO START with IDENTITY_TEST_LOGIN set, and treats an empty one as unset', () => {
    expect(WorkerEnvSchema.safeParse(workerEnv({ IDENTITY_TEST_LOGIN: 'enabled' })).success).toBe(
      false,
    );
    expect(WorkerEnvSchema.safeParse(workerEnv({ IDENTITY_TEST_LOGIN: '' })).success).toBe(true);
  });

  it('the API REQUIRES BETTER_AUTH_SECRET and the worker does not need any sign-in variable', () => {
    expect(ApiEnvSchema.safeParse(workerEnv()).success).toBe(false);
    expect(WorkerEnvSchema.safeParse(workerEnv()).success).toBe(true);
  });

  it('the production sign-in rules belong to the API: a production worker needs no Entra secret and no https APP_URL', () => {
    const production = workerEnv({ NODE_ENV: 'production', APP_URL: 'http://worker.internal' });
    expect(WorkerEnvSchema.safeParse(production).success).toBe(true);
    expect(
      ApiEnvSchema.safeParse({ ...production, BETTER_AUTH_SECRET: 'b'.repeat(32) }).success,
    ).toBe(false);
  });

  describe('EDGE_CLIENT_IP_SECRET (the signed client address, API only)', () => {
    const KEY = 'k'.repeat(40);

    it('is optional on the API outside production: development and CI have no Pages Function in front', () => {
      expect(ApiEnvSchema.safeParse(env()).success).toBe(true);
      expect(ApiEnvSchema.safeParse(env({ NODE_ENV: 'test' })).success).toBe(true);
    });

    it('is REQUIRED in production: unset or empty stops the boot, naming it and why', () => {
      const production = {
        NODE_ENV: 'production',
        APP_URL: 'https://opshub.example.test',
        ENTRA_TENANT_ID: '11111111-1111-4111-8111-111111111111',
        ENTRA_CLIENT_ID: '22222222-2222-4222-8222-222222222222',
        ENTRA_CLIENT_SECRET: 'client-secret',
      };
      for (const value of [undefined, '']) {
        const result = ApiEnvSchema.safeParse(env({ ...production, EDGE_CLIENT_IP_SECRET: value }));
        expect(result.success).toBe(false);
        const issue = result.error?.issues.find((i) => i.path[0] === 'EDGE_CLIENT_IP_SECRET');
        expect(issue?.message).toMatch(/required when NODE_ENV=production/);
        expect(issue?.message).toMatch(/shared Cloudflare address/);
      }
      expect(
        ApiEnvSchema.safeParse(env({ ...production, EDGE_CLIENT_IP_SECRET: KEY })).success,
      ).toBe(true);
    });

    it('the API accepts a key of 32+ characters, and an empty one counts as unset', () => {
      expect(ApiEnvSchema.safeParse(env({ EDGE_CLIENT_IP_SECRET: KEY })).success).toBe(true);
      expect(ApiEnvSchema.safeParse(env({ EDGE_CLIENT_IP_SECRET: '' })).success).toBe(true);
    });

    it.each(['short', ' '.repeat(40), `${'k'.repeat(31)} `])(
      'the API refuses a key under 32 characters once trimmed (%j), without echoing it',
      (value) => {
        const result = ApiEnvSchema.safeParse(env({ EDGE_CLIENT_IP_SECRET: value }));
        expect(result.success).toBe(false);
        expect(JSON.stringify(result.error?.issues)).toMatch(/at least 32 characters/);
      },
    );

    it('the API refuses a PREVIOUS key with no current one: a rotation half done', () => {
      const result = ApiEnvSchema.safeParse(env({ EDGE_CLIENT_IP_SECRET_PREVIOUS: KEY }));
      expect(result.success).toBe(false);
      expect(result.error?.issues.some((i) => i.path[0] === 'EDGE_CLIENT_IP_SECRET_PREVIOUS')).toBe(
        true,
      );
      expect(
        ApiEnvSchema.safeParse(
          env({ EDGE_CLIENT_IP_SECRET: KEY, EDGE_CLIENT_IP_SECRET_PREVIOUS: 'p'.repeat(40) }),
        ).success,
      ).toBe(true);
    });

    it.each(['EDGE_CLIENT_IP_SECRET', 'EDGE_CLIENT_IP_SECRET_PREVIOUS'])(
      'the worker REFUSES TO START with %s set',
      (name) => {
        const result = WorkerEnvSchema.safeParse(workerEnv({ [name]: KEY }));
        expect(result.success).toBe(false);
        expect(result.error?.issues.find((i) => i.path[0] === name)?.message).toMatch(
          /must not be set on the worker/,
        );
        expect(JSON.stringify(result.error?.issues)).not.toContain(KEY);
      },
    );
  });

  it('both roles keep the shared rules (a worker still needs a database)', () => {
    expect(
      WorkerEnvSchema.safeParse({ COOKIE_SECRET: 'y'.repeat(32), CSRF_SECRET: 'z'.repeat(32) })
        .success,
    ).toBe(false);
    expect(WorkerEnvSchema.safeParse(workerEnv()).success).toBe(true);
  });

  it('a process that has not declared its role does not get to guess one', () => {
    resetProcessRoleForTests();
    expect(() => RoleAwareEnvSchema.safeParse(env())).toThrow(/process role is not set/);
    setProcessRole('api'); // restore what test/setup.ts declared
  });

  it('validates with the schema of the role the entry point declared', () => {
    setProcessRole('api');
    expect(RoleAwareEnvSchema.safeParse(env(GRAPH)).success).toBe(false);
    setProcessRole('worker');
    expect(RoleAwareEnvSchema.safeParse(workerEnv(GRAPH)).success).toBe(true);
    expect(RoleAwareEnvSchema.safeParse(workerEnv({ ENTRA_CLIENT_SECRET: 'x' })).success).toBe(
      false,
    );
  });

  it('is enforced by the TYPES too: the API cannot read a Graph variable, the worker cannot read the sign-in secret', () => {
    // Compile-time assertions; the `@ts-expect-error` lines fail `tsc` if the boundary is ever widened.
    const never = () => {
      const api = {} as ApiConfigService;
      const worker = {} as WorkerConfigService;
      const common = {} as AppConfigService;
      // @ts-expect-error GRAPH_CLIENT_ID is not an API variable
      api.get('GRAPH_CLIENT_ID');
      // @ts-expect-error ENTRA_CLIENT_SECRET is not a worker variable
      worker.get('ENTRA_CLIENT_SECRET');
      // @ts-expect-error BETTER_AUTH_SECRET is not a worker variable
      worker.get('BETTER_AUTH_SECRET');
      // @ts-expect-error BETTER_AUTH_SECRET is API-only, so not on the common config either
      common.get('BETTER_AUTH_SECRET');
      api.get('BETTER_AUTH_SECRET');
      api.get('ENTRA_CLIENT_SECRET');
      worker.get('GRAPH_CLIENT_ID');
    };
    expect(typeof never).toBe('function');
  });
});
