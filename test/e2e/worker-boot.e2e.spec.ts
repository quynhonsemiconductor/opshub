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
import { AUTH } from '@quynhonsemiconductor/identity/nest';
import { SESSION_REVOKER } from '@platform';
import { WorkerModule } from '../../apps/worker/src/worker.module';

let ctx: INestApplicationContext;

beforeAll(async () => {
  ctx = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
}, 60_000);

afterAll(async () => {
  await ctx?.close();
});

describe('the worker process', () => {
  it('boots', () => {
    expect(ctx).toBeDefined();
  });

  it('has no SessionRevoker: only the API binds one', () => {
    expect(() => void ctx.get(SESSION_REVOKER, { strict: false })).toThrow();
  });

  it('has no identity instance and no session guard', () => {
    expect(() => void ctx.get(AUTH, { strict: false })).toThrow();
  });
});
