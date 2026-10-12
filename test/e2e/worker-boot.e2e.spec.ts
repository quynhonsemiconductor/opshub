/**
 * The worker boots against the real database WITHOUT identity's authentication.
 *
 * The worker has no HTTP server and no user session. It compiles `EmployeesModule` (the employee service is
 * shared with the API), but must never load `AuthModule`: that module mounts Better Auth on Fastify and
 * registers a global session guard, and both would fail (or worse, half work) in a process with no HTTP
 * adapter. So the one provider only the API binds, `SESSION_REVOKER`, must be absent here, and the
 * employee service must say so loudly instead of skipping a revocation.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d`, `pnpm db:migrate`, `pnpm db:seed`.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setProcessRole } from '@platform/config/process-role';
import { AUTH } from '@quynhonsemiconductor/identity/nest';
import { SESSION_REVOKER } from '@platform';
import { WorkerModule } from '../../apps/worker/src/worker.module';

let ctx: INestApplicationContext;

/**
 * What the API's environment has and the worker's must not: the worker's schema refuses to start with any of
 * these set (it could forge a session, or complete a sign-in). The e2e config sets them for the API specs, so
 * a REAL worker boot has to run without them.
 */
const API_ONLY_ENV = ['BETTER_AUTH_SECRET', 'IDENTITY_TEST_LOGIN', 'ENTRA_CLIENT_SECRET'] as const;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const key of API_ONLY_ENV) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  setProcessRole('worker'); // validate the environment as the worker does, not as the API
  ctx = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
}, 60_000);

afterAll(async () => {
  await ctx?.close();
  for (const key of API_ONLY_ENV) {
    if (saved[key] !== undefined) process.env[key] = saved[key];
  }
  setProcessRole('api');
});

describe('the worker process', () => {
  it('boots with the WORKER’s environment: no sign-in secret, validated by the worker’s schema', () => {
    expect(ctx).toBeDefined();
  });

  it('has no SessionRevoker: only the API binds one', () => {
    expect(() => void ctx.get(SESSION_REVOKER, { strict: false })).toThrow();
  });

  it('has no identity instance and no session guard', () => {
    expect(() => void ctx.get(AUTH, { strict: false })).toThrow();
  });
});
