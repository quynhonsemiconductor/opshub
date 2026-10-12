/**
 * The worker boots against the real database WITHOUT identity's authentication, and validates its environment
 * with the WORKER's schema.
 *
 * The worker has no HTTP server and no user session. It compiles `EmployeesModule` (the employee service is
 * shared with the API), but must never load `AuthModule`: that module mounts Better Auth on Fastify and
 * registers a global session guard, and both would fail (or worse, half work) in a process with no HTTP
 * adapter. So the one provider only the API binds, `SESSION_REVOKER`, must be absent here, and the services
 * that need it must say so loudly instead of skipping a revocation.
 *
 * WHY EVERYTHING IS IMPORTED DYNAMICALLY. `ConfigModule.forRoot` validates the environment when
 * `@platform/config/config.module` is first IMPORTED, against the schema of the role declared at that moment.
 * A static `import { WorkerModule }` (or any import of `@platform`) at the top of this file would load the
 * config module under the role `test/setup.ts` declares for every suite (the API) before `beforeAll` could say
 * otherwise, and "validated by the worker's schema" would be a claim about nothing. So the role is declared
 * first, the module registry is reset, and only then is the worker's module graph imported.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d`, `pnpm db:migrate`, `pnpm db:seed`.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AUTH } from '@quynhonsemiconductor/identity/nest';

/**
 * What the API's environment has and the worker's must not: the worker's schema refuses to start with any of
 * these set (it could forge a session, or complete a sign-in). The e2e config sets them for the API specs.
 * Blanked rather than deleted: a variable already in the environment wins over a `.env` file, and an empty
 * value counts as unset, which is exactly how `pnpm start:dev:worker` runs a worker next to the API's `.env`.
 */
const API_ONLY_ENV = ['BETTER_AUTH_SECRET', 'IDENTITY_TEST_LOGIN', 'ENTRA_CLIENT_SECRET'] as const;
const saved: Record<string, string | undefined> = {};

let ctx: INestApplicationContext;
let sessionRevokerToken: symbol;
let workerEnvIsValid: boolean;
let roleAwareRefusesApiSecret: boolean;

function blankApiOnlyEnv(): void {
  for (const key of API_ONLY_ENV) process.env[key] = '';
}

/**
 * Declare the role on the CURRENT module registry. `vi.resetModules()` discards `process-role`'s state with
 * everything else, so the role has to be declared again, on the fresh copy, before the config module loads.
 */
async function declareRole(role: 'api' | 'worker'): Promise<void> {
  const { setProcessRole } = await import('@platform/config/process-role');
  setProcessRole(role);
}

beforeAll(async () => {
  for (const key of API_ONLY_ENV) saved[key] = process.env[key];

  // The real boot: a clean registry, no API-only variable.
  vi.resetModules();
  await declareRole('worker');
  blankApiOnlyEnv();
  const { EnvSchema, WorkerEnvSchema } = await import('@platform/config/env.schema');
  workerEnvIsValid = WorkerEnvSchema.safeParse(process.env).success;
  // The schema the config module will validate with, resolved from the role declared on THIS registry: it must
  // be the worker's, which refuses the API's secret by name.
  roleAwareRefusesApiSecret = JSON.stringify(
    EnvSchema.safeParse({ ...process.env, BETTER_AUTH_SECRET: 'x'.repeat(32) }),
  ).includes('must not be set on the worker');
  const { WorkerModule } = await import('../../apps/worker/src/worker.module');
  ({ SESSION_REVOKER: sessionRevokerToken } = await import('@platform/auth/session-revoker'));
  ctx = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
}, 60_000);

afterAll(async () => {
  await ctx?.close();
  for (const key of API_ONLY_ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.resetModules();
  await declareRole('api');
});

describe('the worker process', () => {
  it('validates with the WORKER’s schema: the role-aware schema refuses the API’s secret by name', () => {
    expect(roleAwareRefusesApiSecret, 'the schema in force is not the worker’s').toBe(true);
  });

  it('accepts this environment, which has no sign-in secret at all', () => {
    expect(workerEnvIsValid, 'the worker schema rejected the worker environment').toBe(true);
  });

  it('boots WITHOUT BETTER_AUTH_SECRET, which the API schema requires: so the config was validated as the worker', () => {
    // Under the API role this boot would have failed on the missing secret; reaching here is the proof.
    expect(ctx).toBeDefined();
  });

  it('has no SessionRevoker: only the API binds one', () => {
    expect(() => void ctx.get(sessionRevokerToken, { strict: false })).toThrow();
  });

  it('has no identity instance and no session guard', () => {
    expect(() => void ctx.get(AUTH, { strict: false })).toThrow();
  });
});
