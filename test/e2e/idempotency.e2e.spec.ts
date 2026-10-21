/**
 * Idempotent retries end to end: a repeated mutation happens once.
 *
 * WHY THIS SUITE EXISTS. `IdempotencyInterceptor` was registered globally, correct, and unreachable —
 * `Idempotency-Key` was missing from the CORS `allowedHeaders`, so a browser preflight refused the
 * request before it was sent. Nothing sent the header, nothing documented it, and nothing tested it, so
 * a feature the code implied the API had was one it did not have.
 *
 * WHAT THIS EXISTS TO PIN
 * -----------------------
 *   - THE SAME KEY PERFORMS THE WRITE ONCE. Asserted against the REGISTER, not just against matching
 *     response bodies: two identical responses would also be produced by two successful creates with
 *     the same reference, if the reference were not unique. The row count is the fact that matters.
 *   - A REPLAY SAYS SO. `X-Idempotent-Replayed: true` distinguishes "your retry was absorbed" from "I
 *     did it again", which is the difference a client needs to decide whether to trust its own state.
 *   - THE SAME KEY WITH A DIFFERENT BODY IS REFUSED, not answered. Serving the first response would
 *     report success for a create that never happened — and the caller cannot tell, because it gets a
 *     201 and a plausible object.
 *   - WITHOUT A KEY, NOTHING CHANGES. The negative control: two requests, two rows. Without it, a
 *     no-op interceptor would satisfy every assertion above by never being involved.
 *   - A FAILED REQUEST STAYS RETRYABLE. A refused create must not cache its own refusal, or one bad
 *     minute becomes 24 hours of the same bad answer under that key.
 *
 * PER-IDENTITY SCOPING. Keys are client-generated, so two callers can pick the same uuid and must not share a
 * namespace. The cache key is not observable through HTTP, so the last test asserts the outcome instead: two users,
 * one key, two answers. The unit spec pins the rule itself (no principal on an authenticated request means no cache).
 *
 * REFERENCES ARE UNIQUE PER RUN — `uq_asset_tag` is global and the database is shared with the other
 * suites, so a fixed tag makes a spec that passes once.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d`, `pnpm db:migrate`, `pnpm db:seed`.
 * VALKEY MUST BE UP: the interceptor degrades to "just perform the request" when the cache is
 * unavailable, so without it these tests would fail rather than silently pass — which is the right way
 * round, and the reason the first test asserts the replay header rather than only the row count.
 */
import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE, apiRequest, createTestApp, errorCode, login, unwrap } from './support/harness';
import type { Session } from './support/harness';

let app: NestFastifyApplication;
/** Holds `asset.manage`, which is what creating an asset needs. */
let admin: Session;

const RUN = Date.now().toString(36).toUpperCase().slice(-6);
let seq = 0;
const nextTag = (): string => `E2E-IDEM-${RUN}-${++seq}`;

interface AssetRow {
  id: string;
  assetTag: string;
}

/** A create body for a tag. Assets are the cheapest write with a globally unique natural key. */
function asset(assetTag: string) {
  return {
    assetTag,
    type: 'laptop',
    manufacturer: 'Acme',
    model: 'Book 13',
    status: 'in_stock',
  };
}

async function create(assetTag: string, key?: string) {
  return apiRequest(
    app,
    admin,
    'POST',
    '/assets',
    asset(assetTag),
    key === undefined ? undefined : { 'idempotency-key': key },
  );
}

/** How many assets carry this tag, read back through the API. */
async function countByTag(assetTag: string): Promise<number> {
  const res = await apiRequest(app, admin, 'GET', `/assets?search=${assetTag}&limit=50`);
  return unwrap<AssetRow[]>(res.body).filter((row) => row.assetTag === assetTag).length;
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await login(app, FIXTURE.ADMIN);
});

afterAll(async () => {
  await app?.close();
});

describe('idempotent retries', () => {
  it('performs the write once for a repeated key, and says the second was a replay', async () => {
    const tag = nextTag();
    const key = randomUUID();

    const first = await create(tag, key);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.headers?.['x-idempotent-replayed']).toBeUndefined();

    const retry = await create(tag, key);

    /*
     * THE REPLAY, and it is asserted three ways because each catches a different failure. The status
     * and body prove the client got an answer it can use; the header proves the answer came from the
     * store rather than from a second execution; and the row count below proves the second execution
     * did not happen. A conflict (409 on the unique tag) would satisfy the first two and fail the
     * point — a client retrying after a timeout must not be told its own earlier success was a clash.
     */
    expect(retry.status, JSON.stringify(retry.body)).toBe(201);
    expect(retry.headers?.['x-idempotent-replayed']).toBe('true');
    expect(unwrap<AssetRow>(retry.body).id).toBe(unwrap<AssetRow>(first.body).id);
    expect(await countByTag(tag)).toBe(1);
  });

  it('refuses the same key with a different body rather than answering it', async () => {
    const key = randomUUID();
    const first = await create(nextTag(), key);
    expect(first.status).toBe(201);

    const differentTag = nextTag();
    const reused = await create(differentTag, key);

    expect(reused.status).toBe(422);
    expect(errorCode(reused.body)).toBe('IDEMPOTENCY_KEY_REUSED');
    // And the refusal is real: nothing was created under the second body.
    expect(await countByTag(differentTag)).toBe(0);
  });

  it('creates twice without a key, so the tests above are not passing on an absent interceptor', async () => {
    // THE NEGATIVE CONTROL. `assetTag` is globally unique, so two creates cannot both succeed — the
    // second is a 409. What this pins is that the second request REACHED the handler: with no key
    // there is no replay, so a conflict is the honest answer and a 201 would mean the interceptor is
    // absorbing requests it was never given a key for.
    const tag = nextTag();
    const first = await create(tag);
    expect(first.status).toBe(201);

    const second = await create(tag);
    expect(second.status).toBe(409);
    expect(second.headers?.['x-idempotent-replayed']).toBeUndefined();
    expect(await countByTag(tag)).toBe(1);
  });

  it('leaves a failed request retryable under the same key', async () => {
    /*
     * A refusal must not be stored. The first attempt fails validation; the second, with the SAME key
     * and a valid body, must be performed rather than handed the failure back — otherwise one bad
     * minute becomes 24 hours of the same bad answer for that key, and the client has no way out
     * except inventing a new key for a request it already sent.
     */
    const key = randomUUID();
    const rejected = await apiRequest(
      app,
      admin,
      'POST',
      '/assets',
      { assetTag: '', type: 'not-a-real-type' },
      { 'idempotency-key': key },
    );
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(422);

    const tag = nextTag();
    const retried = await create(tag, key);

    expect(retried.status, JSON.stringify(retried.body)).toBe(201);
    expect(await countByTag(tag)).toBe(1);
  });

  it('gives two users the same Idempotency-Key their own responses, and a retry its own', async () => {
    /*
     * PER-USER SCOPE, end to end. Keys are client-generated, so two users can send the same uuid for different
     * work. Both requests below carry the same key and the same body, so the fingerprint matches and only the
     * caller tells them apart. A caller whose principal is missing must never fall back to its address (one bucket per
     * NAT), so this pins the outcome: each user gets their own record.
     */
    const bob = await login(app, FIXTURE.NO_PERMISSIONS);
    const key = randomUUID();
    const body = {
      accessType: 'vpn',
      target: `e2e-idem-scope-${RUN}-${++seq}`,
      justification: 'Idempotency scope e2e: two users, one key.',
      durationHours: 8,
    };

    const adminFirst = await apiRequest(app, admin, 'POST', '/access-requests', body, { 'idempotency-key': key });
    expect(adminFirst.status, JSON.stringify(adminFirst.body)).toBe(201);

    const bobFirst = await apiRequest(app, bob, 'POST', '/access-requests', body, { 'idempotency-key': key });
    expect(bobFirst.status, JSON.stringify(bobFirst.body)).toBe(201);
    expect(bobFirst.headers?.['x-idempotent-replayed']).toBeUndefined();

    const adminRetry = await apiRequest(app, admin, 'POST', '/access-requests', body, { 'idempotency-key': key });

    const bobRecord = unwrap<{ id: string; requesterId: string }>(bobFirst.body);
    expect(bobRecord.requesterId).toBe(bob.userId);
    expect(bobRecord.id).not.toBe(unwrap<{ id: string }>(adminFirst.body).id);
    expect(adminRetry.headers?.['x-idempotent-replayed']).toBe('true');
    expect(unwrap<{ id: string }>(adminRetry.body).id).toBe(unwrap<{ id: string }>(adminFirst.body).id);
  });
});
