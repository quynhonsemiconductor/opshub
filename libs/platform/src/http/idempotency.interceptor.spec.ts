/**
 * The idempotency interceptor, which until now had no test at all — and could not be reached.
 *
 * `Idempotency-Key` was missing from the CORS `allowedHeaders`, so a browser preflight refused the
 * request before it was sent, and `X-Idempotent-Replayed` was missing from `exposedHeaders`, so no
 * browser could have read the answer. Nothing sent the header, nothing documented it, nothing tested it.
 *
 * WHAT THESE TESTS PIN is the difference between a guarantee and a response cache:
 *
 *   - the same key with a DIFFERENT body is refused, not answered with the first response;
 *   - two CONCURRENT copies do not both run the handler;
 *   - a FAILED request stores nothing, so the retry it is entitled to still executes;
 *   - the lock is released either way, so a failure does not lock the client out for 90 seconds.
 *
 * The mechanical skips (GET, no key, no cache) are here too, because each one is a path on which a
 * mutation must run exactly as if the interceptor were absent.
 */
import { firstValueFrom, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IdempotencyInterceptor } from './idempotency.interceptor';

interface Stored {
  fingerprint: string;
  body: unknown;
}

function makeCache(opts: { available?: boolean; stored?: Stored | null; lockFree?: boolean } = {}) {
  return {
    isAvailable: opts.available ?? true,
    getJson: vi.fn().mockResolvedValue(opts.stored ?? null),
    setJson: vi.fn().mockResolvedValue(undefined),
    acquireLock: vi.fn().mockResolvedValue(opts.lockFree ?? true),
    releaseLock: vi.fn().mockResolvedValue(undefined),
  };
}

function makeContext(
  over: {
    method?: string;
    url?: string;
    body?: unknown;
    key?: string;
    user?: { sub: string } | null;
    headers?: Record<string, string>;
  } = {},
) {
  const header = vi.fn();
  const req = {
    method: over.method ?? 'POST',
    url: over.url ?? '/v1/assets',
    body: over.body ?? { assetTag: 'A-1' },
    ip: '203.0.113.7',
    user: over.user === null ? undefined : { sub: 'emp-1' },
    headers: {
      ...(over.key === undefined ? {} : { 'idempotency-key': over.key }),
      ...(over.headers ?? {}),
    },
  };
  return {
    ctx: {
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ header }) }),
    } as never,
    header,
  };
}

const HANDLED = { id: 'asset-1' };
const handler = (value: unknown = HANDLED) => ({ handle: vi.fn(() => of(value)) });

/** The fingerprint the interceptor computes for the default context, taken from its own storage call. */
async function fingerprintOf(over: Parameters<typeof makeContext>[0] = {}): Promise<string> {
  const cache = makeCache();
  const { ctx } = makeContext({ key: 'k', ...over });
  await firstValueFrom(new IdempotencyInterceptor(cache as never).intercept(ctx, handler()));
  return (cache.setJson.mock.calls[0][1] as Stored).fingerprint;
}

describe('IdempotencyInterceptor', () => {
  let cache: ReturnType<typeof makeCache>;

  beforeEach(() => {
    cache = makeCache();
  });

  describe('when it must stay out of the way', () => {
    it.each([['GET'], ['DELETE']])('runs %s straight through', async (method) => {
      const { ctx } = makeContext({ method, key: 'k' });
      const next = handler();

      await firstValueFrom(new IdempotencyInterceptor(cache as never).intercept(ctx, next));

      expect(next.handle).toHaveBeenCalledOnce();
      // Not even a lookup: GET and DELETE are idempotent by definition, so a key adds nothing.
      expect(cache.getJson).not.toHaveBeenCalled();
    });

    it('does nothing without a key, so the header stays opt-in', async () => {
      const { ctx } = makeContext();
      const next = handler();

      await firstValueFrom(new IdempotencyInterceptor(cache as never).intercept(ctx, next));

      expect(next.handle).toHaveBeenCalledOnce();
      expect(cache.acquireLock).not.toHaveBeenCalled();
    });

    it('performs the request when the cache is down rather than refusing it', async () => {
      // Deliberate: degrading to "no guarantee" keeps the API working when Valkey is unavailable. The
      // alternative is refusing every mutation because a cache is down.
      const down = makeCache({ available: false });
      const { ctx } = makeContext({ key: 'k' });
      const next = handler();

      await firstValueFrom(new IdempotencyInterceptor(down as never).intercept(ctx, next));

      expect(next.handle).toHaveBeenCalledOnce();
    });
  });

  describe('first execution', () => {
    it('runs the handler and stores the response under the key', async () => {
      const { ctx } = makeContext({ key: 'k' });
      const next = handler();

      const result = await firstValueFrom(
        new IdempotencyInterceptor(cache as never).intercept(ctx, next),
      );

      expect(result).toEqual(HANDLED);
      expect(cache.setJson).toHaveBeenCalledOnce();
      const [storedKey, record, ttl] = cache.setJson.mock.calls[0] as [string, Stored, number];
      // Scoped by identity: one caller's key must not collide with or read another's.
      expect(storedKey).toBe('idem:emp-1:k');
      expect(record.body).toEqual(HANDLED);
      expect(ttl).toBe(24 * 3600);
    });

    it('releases the lock so the next request is not told "in flight"', async () => {
      const { ctx } = makeContext({ key: 'k' });

      await firstValueFrom(new IdempotencyInterceptor(cache as never).intercept(ctx, handler()));

      expect(cache.releaseLock).toHaveBeenCalledWith('idem:emp-1:k:lock');
    });
  });

  describe('replay', () => {
    it('returns the stored response without running the handler again', async () => {
      const fingerprint = await fingerprintOf();
      const replaying = makeCache({ stored: { fingerprint, body: HANDLED } });
      const { ctx, header } = makeContext({ key: 'k' });
      const next = handler();

      const result = await firstValueFrom(
        new IdempotencyInterceptor(replaying as never).intercept(ctx, next),
      );

      expect(result).toEqual(HANDLED);
      // The whole point: the mutation does not happen twice.
      expect(next.handle).not.toHaveBeenCalled();
      expect(header).toHaveBeenCalledWith('x-idempotent-replayed', 'true');
    });

    it('refuses the same key with a different body instead of answering it', async () => {
      /*
       * THE DIFFERENCE BETWEEN A GUARANTEE AND A CACHE. Serving the first request's response to a
       * different request reports success for work that was never done — and the caller has no way to
       * notice, because it gets a 200 and a plausible body.
       */
      const replaying = makeCache({
        stored: { fingerprint: 'a-different-request', body: HANDLED },
      });
      const { ctx } = makeContext({ key: 'k' });
      const next = handler();

      await expect(
        firstValueFrom(new IdempotencyInterceptor(replaying as never).intercept(ctx, next)),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', httpStatus: 422 });
      expect(next.handle).not.toHaveBeenCalled();
    });

    it('treats the same body on a different route as a different request', async () => {
      // Method and path are in the fingerprint, so an empty-bodied `POST /x/activate` and
      // `POST /y/activate` do not hash alike.
      const onAssets = await fingerprintOf({ url: '/v1/assets' });
      const onVendors = await fingerprintOf({ url: '/v1/vendors' });
      expect(onAssets).not.toBe(onVendors);
    });

    it('treats the same body under a different method as a different request', async () => {
      const posted = await fingerprintOf({ method: 'POST' });
      const patched = await fingerprintOf({ method: 'PATCH' });
      expect(posted).not.toBe(patched);
    });
  });

  describe('concurrency', () => {
    it('refuses a second copy while the first is still running', async () => {
      /*
       * The case the header exists FOR: a client timed out and retried. Before the lock, both copies
       * missed the empty cache and both executed — so the interceptor only helped a retry that arrived
       * after the first one had finished, which is the easy half of the problem.
       */
      const busy = makeCache({ lockFree: false });
      const { ctx } = makeContext({ key: 'k' });
      const next = handler();

      await expect(
        firstValueFrom(new IdempotencyInterceptor(busy as never).intercept(ctx, next)),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_IN_FLIGHT', httpStatus: 409 });
      expect(next.handle).not.toHaveBeenCalled();
    });
  });

  describe('failure', () => {
    it('stores nothing, so the retry a client is entitled to still executes', async () => {
      const { ctx } = makeContext({ key: 'k' });
      const failing = { handle: vi.fn(() => throwError(() => new Error('boom'))) };

      await expect(
        firstValueFrom(new IdempotencyInterceptor(cache as never).intercept(ctx, failing)),
      ).rejects.toThrow('boom');

      // Caching a failure would turn one bad minute into 24 hours of the same bad answer.
      expect(cache.setJson).not.toHaveBeenCalled();
    });

    it('releases the lock on failure, so the client is not locked out for 90 seconds', async () => {
      const { ctx } = makeContext({ key: 'k' });
      const failing = { handle: vi.fn(() => throwError(() => new Error('boom'))) };

      await expect(
        firstValueFrom(new IdempotencyInterceptor(cache as never).intercept(ctx, failing)),
      ).rejects.toThrow('boom');

      expect(cache.releaseLock).toHaveBeenCalledWith('idem:emp-1:k:lock');
    });
  });

  it('scopes an UNauthenticated caller by clientIp(): the signed/cf address, never a header the caller sets', async () => {
    const cache = makeCache();
    const interceptor = new IdempotencyInterceptor(cache as never);
    const { ctx } = makeContext({
      key: 'k-1',
      user: null,
      headers: {
        'cf-connecting-ip': '198.51.100.9',
        'x-real-ip': '192.0.2.1',
        'x-forwarded-for': '192.0.2.2',
      },
    });

    await firstValueFrom(interceptor.intercept(ctx, handler()));

    expect(cache.getJson).toHaveBeenCalledWith('idem:ip:198.51.100.9:k-1');
  });
});
