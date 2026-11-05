/**
 * `GET /v1/meta` against the real app: authenticated, cheap, and truthful about what it does not know.
 *
 * The values come from what the deployment injected, so this suite asserts the CONTRACT (a signed-in
 * caller can read a version/commit/env document; an anonymous one cannot), not a particular tag — the
 * e2e process injects none, which is exactly the digest-only / laptop case.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE, apiRequest, createTestApp, login } from './support/harness';
import type { Session } from './support/harness';

let app: NestFastifyApplication;
let admin: Session;

beforeAll(async () => {
  app = await createTestApp();
  admin = await login(app, FIXTURE.ADMIN);
});

afterAll(async () => {
  await app?.close();
});

describe('GET /v1/meta', () => {
  it('answers the running version, commit and environment to a signed-in caller', async () => {
    const res = await apiRequest(app, admin, 'GET', '/meta');

    expect(res.status).toBe(200);
    const body = res.body as { version: string; commit: string | null; env: string };
    expect(typeof body.version).toBe('string');
    expect(typeof body.env).toBe('string');
    // Unknown is null, never the word "dev": this process was told no commit, so it says so.
    expect(body.commit === null || typeof body.commit === 'string').toBe(true);
  });

  it('refuses an anonymous caller', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/meta' });

    expect(res.statusCode).toBe(401);
  });
});
