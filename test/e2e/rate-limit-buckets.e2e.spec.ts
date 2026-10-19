/**
 * The two rate-limit buckets against the real app, Valkey and identity.
 *
 * WHAT THIS PINS. A signed-in request is counted against its USER (`rl:DEFAULT:uid:<id>`), not against the address,
 * so an office behind one address is not spent by its normal traffic. A request identity does not verify (a 401, a
 * forged cookie) keeps its slot against the address. The first is only true if the per-user guard runs AFTER identity's SessionGuard has recorded
 * the principal, so this suite is also the check on the module order in `auth.module.ts`.
 *
 * Reads the counts straight from Valkey: the keys are the contract, and there is no HTTP surface for them.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { CacheService } from '@quynhonsemiconductor/platform-cache';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE, apiRequest, createTestApp, login } from './support/harness';
import type { Session } from './support/harness';

let app: NestFastifyApplication;
let admin: Session;

/** Entries the sliding window holds for a key, read without recording anything. */
async function windowSize(key: string): Promise<number> {
  const redis = app.get(CacheService).redis;
  if (!redis) throw new Error('the e2e run needs Valkey for the rate-limit assertions');
  return redis.zcard(key);
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await login(app, FIXTURE.ADMIN);
});

afterAll(async () => {
  await app?.close();
});

describe('rate-limit buckets', () => {
  it('counts a signed-in request against the user, and not against the address', async () => {
    const userKey = `rl:DEFAULT:uid:${admin.userId}`;
    const addressKey = 'rl:IP:127.0.0.1';
    const userBefore = await windowSize(userKey);
    const addressBefore = await windowSize(addressKey);

    const res = await apiRequest(app, admin, 'GET', '/assets?limit=1');

    expect(res.status).toBe(200);
    // Written only if the per-user guard saw the principal: a wrong module order leaves this key unwritten.
    expect(await windowSize(userKey)).toBe(userBefore + 1);
    // A 200 is not a failed authentication, so the per-address window does not move.
    expect(await windowSize(addressKey)).toBe(addressBefore);
  });

  it('keeps the address slot of a request identity does not verify (a 401)', async () => {
    const addressKey = 'rl:IP:127.0.0.1';
    const before = await windowSize(addressKey);

    const res = await app.inject({ method: 'GET', url: '/v1/assets' });

    expect(res.statusCode).toBe(401);
    expect(await windowSize(addressKey)).toBe(before + 1);
  });
});
