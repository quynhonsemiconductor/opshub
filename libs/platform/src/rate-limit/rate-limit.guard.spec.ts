import { HttpException } from '@nestjs/common';
import { requestContextStorage } from '@quynhonsemiconductor/observability';
import { GlobalExceptionFilter } from '@quynhonsemiconductor/platform-http';
import { describe, expect, it, vi } from 'vitest';
import { PRE_AUTH_IP_BUCKET, RATE_LIMIT_TIER, SKIP_RATE_LIMIT } from './rate-limit.constants';
import { RateLimitGuard, UserRateLimitGuard } from './rate-limit.guard';

/**
 * Two buckets: the pre-auth one per verified client address (every request), and the per-user one for an
 * authenticated caller. Neither is keyed by a cookie. See the guard's docblock for why.
 */

interface Overrides {
  ip?: string;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  user?: { sub: string };
  tier?: string;
  skip?: boolean;
}

/** A reflector that answers the two metadata keys the guards read. */
function reflectorFor(over: Overrides = {}) {
  return {
    getAllAndOverride: vi.fn((key: symbol) => {
      if (key === RATE_LIMIT_TIER) return over.tier;
      if (key === SKIP_RATE_LIMIT) return over.skip;
      return undefined;
    }),
  };
}

function contextFor(over: Overrides = {}) {
  const request = {
    headers: over.headers ?? {},
    ip: over.ip ?? '203.0.113.9',
    user: over.user,
    cookies: over.cookies ?? {},
  };
  const response = { header: vi.fn() };
  return {
    context: {
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
      getHandler: () => () => undefined,
      getClass: () => class {},
    } as never,
    request,
    response,
  };
}

/** A cache with real counting: admits up to `limit` per key in the window, then refuses. */
function countingCache() {
  const counts = new Map<string, number>();
  return {
    counts,
    consumeRateLimit: vi.fn((key: string, limit: number) => {
      const used = (counts.get(key) ?? 0) + 1;
      counts.set(key, used);
      return Promise.resolve({
        allowed: used <= limit,
        remaining: Math.max(0, limit - used),
        resetAt: Math.floor(Date.now() / 1000) + 60,
      });
    }),
  };
}

/** Runs `fn` as an authenticated request for `userId`, as identity's SessionGuard leaves it. */
function asUser<T>(userId: string, fn: () => T): T {
  return requestContextStorage.run(
    {
      workspaceId: undefined,
      userId,
      sessionId: 's-1',
      correlationId: 'c-1',
      traceparent: undefined,
    },
    fn,
  );
}

describe('RateLimitGuard (pre-auth, per verified address)', () => {
  it('counts a request against its address, and never against a cookie', async () => {
    const cache = countingCache();
    const guard = new RateLimitGuard(reflectorFor() as never, cache as never);

    await guard.canActivate(contextFor({ cookies: { session_token: 'anything' } }).context);

    expect(cache.consumeRateLimit.mock.calls[0][0]).toBe('IP:203.0.113.9');
  });

  it('refuses a caller who mints a fresh random cookie per request once the address bucket is spent', async () => {
    const cache = countingCache();
    const guard = new RateLimitGuard(reflectorFor() as never, cache as never);

    let refused: unknown;
    for (let i = 0; i <= PRE_AUTH_IP_BUCKET.limit; i++) {
      const { context } = contextFor({ cookies: { session_token: `random-${i}` } });
      try {
        await guard.canActivate(context);
      } catch (err) {
        refused ??= err;
      }
    }

    // Before this change every random cookie opened a new bucket, so none of these was ever refused.
    expect(refused).toBeInstanceOf(HttpException);
    expect((refused as HttpException).getStatus()).toBe(429);
    expect(cache.counts.size).toBe(1);
  });

  it('gives two addresses two buckets', async () => {
    const cache = countingCache();
    const guard = new RateLimitGuard(reflectorFor() as never, cache as never);

    await guard.canActivate(contextFor({ ip: '198.51.100.1' }).context);
    await guard.canActivate(contextFor({ ip: '198.51.100.2' }).context);

    expect(cache.consumeRateLimit.mock.calls.map((call) => call[0])).toEqual([
      'IP:198.51.100.1',
      'IP:198.51.100.2',
    ]);
  });

  it('never sets the KEYED_BY_ADDRESS marker: that is for a caller the per-user bucket cannot key', async () => {
    const cache = countingCache();
    const guard = new RateLimitGuard(reflectorFor() as never, cache as never);
    const { context, request } = contextFor();

    await guard.canActivate(context);

    expect(Object.getOwnPropertySymbols(request)).toEqual([]);
  });

  describe('the address comes from clientIp(), never from a header the caller can choose', () => {
    const keyFor = async (headers: Record<string, string>, ip = '10.0.0.1') => {
      const cache = countingCache();
      const guard = new RateLimitGuard(reflectorFor() as never, cache as never);
      await guard.canActivate(contextFor({ headers, ip }).context);
      return cache.consumeRateLimit.mock.calls[0][0];
    };

    it('cf-connecting-ip wins over a forged x-forwarded-for and x-real-ip', async () => {
      expect(
        await keyFor({
          'cf-connecting-ip': '203.0.113.7',
          'x-forwarded-for': '198.51.100.99',
          'x-real-ip': '192.0.2.1',
        }),
      ).toBe('IP:203.0.113.7');
    });

    it('x-real-ip is not read at all: a caller cannot pick its own bucket with it', async () => {
      expect(await keyFor({ 'x-real-ip': '192.0.2.1' })).toBe('IP:10.0.0.1');
      expect(await keyFor({ 'x-real-ip': '192.0.2.2' })).toBe('IP:10.0.0.1');
    });

    it('a header value that is not an IP address is skipped, not used as a key', async () => {
      expect(await keyFor({ 'cf-connecting-ip': 'not-an-ip\r\nx' })).toBe('IP:10.0.0.1');
    });
  });

  it('throws a body the exception filter can read the message out of', async () => {
    const cache = countingCache();
    cache.consumeRateLimit.mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: Math.floor(Date.now() / 1000) + 42,
    });
    const guard = new RateLimitGuard(reflectorFor() as never, cache as never);

    const thrown = await guard.canActivate(contextFor().context).catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(HttpException);

    const body = (thrown as HttpException).getResponse() as Record<string, unknown>;
    // FLAT: a nested `{ error: { message } }` is what produced the `"Error"` message.
    expect(body.error, 'the body must not nest another envelope inside itself').toBeUndefined();
    expect(body.message).toMatch(/Too many requests — retry after \d+s\./);
    expect(body.retryAfter).toBeGreaterThan(0);
    expect(body['message'] as string).not.toBe('Error');
    expect(GlobalExceptionFilter).toBeTypeOf('function');
  });

  it('fails open when the cache is down', async () => {
    const cache = { consumeRateLimit: vi.fn().mockRejectedValue(new Error('valkey down')) };
    const guard = new RateLimitGuard(reflectorFor() as never, cache as never);

    await expect(guard.canActivate(contextFor().context)).resolves.toBe(true);
  });

  it('honours @SkipRateLimit()', async () => {
    const cache = countingCache();
    const guard = new RateLimitGuard(reflectorFor({ skip: true }) as never, cache as never);

    await expect(guard.canActivate(contextFor().context)).resolves.toBe(true);
    expect(cache.consumeRateLimit).not.toHaveBeenCalled();
  });
});

describe('UserRateLimitGuard (authenticated, per user)', () => {
  it('counts an authenticated caller against uid:<userId>, with the route tier', async () => {
    const cache = countingCache();
    const guard = new UserRateLimitGuard(reflectorFor() as never, cache as never);

    await asUser('emp-1', () => guard.canActivate(contextFor().context));

    expect(cache.consumeRateLimit.mock.calls[0][0]).toBe('DEFAULT:uid:emp-1');
  });

  it('gives every cookie variant of one signed-in session the same user bucket', async () => {
    // Cookie encoding variants (padding, quoting) reach identity as the same session, so they must not each open
    // a bucket. The bucket is keyed by the verified user, and the cookie is not in the key at all.
    const cache = countingCache();
    const guard = new UserRateLimitGuard(reflectorFor() as never, cache as never);

    await asUser('emp-1', () =>
      guard.canActivate(contextFor({ cookies: { session_token: 'abc' } }).context),
    );
    await asUser('emp-1', () =>
      guard.canActivate(contextFor({ cookies: { session_token: '"abc"' } }).context),
    );

    expect(new Set(cache.consumeRateLimit.mock.calls.map((call) => call[0]))).toEqual(
      new Set(['DEFAULT:uid:emp-1']),
    );
  });

  it('refuses the AI tier after its own ceiling, per user', async () => {
    const cache = countingCache();
    const guard = new UserRateLimitGuard(reflectorFor({ tier: 'AI' }) as never, cache as never);

    let refused: unknown;
    for (let i = 0; i < 11; i++) {
      await asUser('emp-1', () =>
        guard.canActivate(contextFor().context).catch((err: unknown) => {
          refused = err;
        }),
      );
    }

    expect((refused as HttpException).getStatus()).toBe(429);
    expect(cache.counts.get('AI:uid:emp-1')).toBe(11);
  });

  it('does nothing without a principal: a public route or a refused request is the pre-auth bucket’s', async () => {
    const cache = countingCache();
    const guard = new UserRateLimitGuard(reflectorFor() as never, cache as never);

    await expect(guard.canActivate(contextFor().context)).resolves.toBe(true);
    expect(cache.consumeRateLimit).not.toHaveBeenCalled();
  });

  it('does not treat req.user alone as a principal', async () => {
    const cache = countingCache();
    const guard = new UserRateLimitGuard(reflectorFor() as never, cache as never);

    await guard.canActivate(contextFor({ user: { sub: 'from-req-user' } }).context);

    expect(cache.consumeRateLimit).not.toHaveBeenCalled();
  });

  it('applies the configured DEFAULT ceiling, and never to other tiers', async () => {
    const cache = countingCache();
    const config = { get: vi.fn(() => 50) };
    const guard = new UserRateLimitGuard(reflectorFor() as never, cache as never, config as never);

    await asUser('emp-1', () => guard.canActivate(contextFor().context));
    expect(cache.consumeRateLimit.mock.calls[0][1]).toBe(50);

    const aiGuard = new UserRateLimitGuard(
      reflectorFor({ tier: 'AI' }) as never,
      cache as never,
      config as never,
    );
    await asUser('emp-1', () => aiGuard.canActivate(contextFor().context));
    expect(cache.consumeRateLimit.mock.calls[1][1]).toBe(10);
  });
});
