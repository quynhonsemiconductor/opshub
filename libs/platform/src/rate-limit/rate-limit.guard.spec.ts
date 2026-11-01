import { EventEmitter } from 'node:events';
import { HttpException } from '@nestjs/common';
import { requestContextStorage } from '@quynhonsemiconductor/observability';
import { GlobalExceptionFilter, KEYED_BY_ADDRESS } from '@quynhonsemiconductor/platform-http';
import { describe, expect, it, vi } from 'vitest';
import { PRE_AUTH_IP_BUCKET, RATE_LIMIT_TIER, SKIP_RATE_LIMIT } from './rate-limit.constants';
import { RateLimitGuard, UserRateLimitGuard } from './rate-limit.guard';

/**
 * Two buckets. The pre-auth one per verified address reserves a slot for every request and keeps it unless identity
 * verified the caller, and refuses before the request runs once the window is full. The per-user one counts an
 * authenticated caller.
 * Neither is keyed by a cookie. See the guard's docblock for why.
 */

interface Overrides {
  ip?: string;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  user?: { sub: string };
  tier?: string;
  skip?: boolean;
}

function reflectorFor(over: Overrides = {}) {
  return {
    getAllAndOverride: vi.fn((key: symbol) => {
      if (key === RATE_LIMIT_TIER) return over.tier;
      if (key === SKIP_RATE_LIMIT) return over.skip;
      return undefined;
    }),
  };
}

/**
 * A request and its reply. `status` is the response code the guard sees when the reply finishes; `finish()` plays
 * the reply going out. Nothing refunds or counts on finish: only the per-user guard gives a slot back.
 */
function contextFor(over: Overrides = {}) {
  const request = {
    headers: over.headers ?? {},
    ip: over.ip ?? '203.0.113.9',
    user: over.user,
    cookies: over.cookies ?? {},
  };
  const raw = new EventEmitter();
  const response = { header: vi.fn(), statusCode: 200, raw };
  return {
    context: {
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
      getHandler: () => () => undefined,
      getClass: () => class {},
    } as never,
    request,
    response,
    finish: (status: number) => {
      response.statusCode = status;
      raw.emit('finish');
    },
  };
}

/**
 * A cache with the sliding window the shared limiter keeps, and the reserve/refund pair on top. `consumeRateLimit`
 * takes a slot and returns its id, atomically (one synchronous step, as the Lua script is on the server);
 * `refundRateLimit` removes exactly that entry. `sets` holds what the window holds, by key.
 */
function windowCache() {
  const sets = new Map<string, Array<{ id: string; at: number }>>();
  const live = (key: string, from: number) =>
    (sets.get(`rl:${key}`) ?? []).filter((e) => e.at >= from);
  let seq = 0;
  return {
    sets,
    live,
    consumeRateLimit: vi.fn((key: string, limit: number, windowSeconds: number) => {
      const now = Date.now();
      const kept = live(key, now - windowSeconds * 1000);
      if (kept.length >= limit) {
        return Promise.resolve({
          allowed: false,
          remaining: 0,
          resetAt: Math.ceil(now / 1000) + windowSeconds,
        });
      }
      const id = `slot-${++seq}`;
      sets.set(`rl:${key}`, [...kept, { id, at: now }]);
      return Promise.resolve({
        allowed: true,
        remaining: Math.max(0, limit - kept.length - 1),
        resetAt: Math.ceil(now / 1000) + windowSeconds,
        id,
      });
    }),
    refundRateLimit: vi.fn((key: string, id: string) => {
      const entries = sets.get(`rl:${key}`) ?? [];
      sets.set(
        `rl:${key}`,
        entries.filter((e) => e.id !== id),
      );
      return Promise.resolve();
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

describe('RateLimitGuard (pre-auth, per verified address: kept unless identity verifies the caller)', () => {
  it('reserves a slot before the request runs, and gives it back as soon as identity has verified the caller', async () => {
    const cache = windowCache();
    const pre = new RateLimitGuard(reflectorFor() as never, cache as never);
    const user = new UserRateLimitGuard(reflectorFor() as never, cache as never);
    const { context, finish } = contextFor({ cookies: { session_token: 'valid' } });

    await pre.canActivate(context);
    expect(cache.live('IP:203.0.113.9', 0)).toHaveLength(1); // held while identity verifies the session
    await asUser('emp-1', () => user.canActivate(context));

    // Refunded before the reply finishes, so a stream that never finishes does not hold it.
    expect(cache.live('IP:203.0.113.9', 0)).toHaveLength(0);
    finish(200);
    expect(cache.refundRateLimit).toHaveBeenCalledTimes(1); // and never twice
  });

  it('gives the slot back ONCE, however many times the per-user guard runs for one request', async () => {
    const cache = windowCache();
    const pre = new RateLimitGuard(reflectorFor() as never, cache as never);
    const user = new UserRateLimitGuard(reflectorFor() as never, cache as never);
    const { context } = contextFor({ cookies: { session_token: 'valid' } });

    await pre.canActivate(context);
    await asUser('emp-1', () => user.canActivate(context));
    await asUser('emp-1', () => user.canActivate(context));

    expect(cache.refundRateLimit).toHaveBeenCalledTimes(1);
    expect(cache.live('IP:203.0.113.9', 0)).toHaveLength(0);
  });

  it('leaves a signed-in address bucket at zero however many streams stay open or requests abort', async () => {
    // N open SSE streams (identity verified, reply never finishes) and aborted signed-in requests. Before the refund
    // moved to identity verification these held one slot each until the window ran out.
    const cache = windowCache();
    const pre = new RateLimitGuard(reflectorFor() as never, cache as never);
    const user = new UserRateLimitGuard(reflectorFor() as never, cache as never);

    for (let i = 0; i < 500; i++) {
      const { context, response } = contextFor({ cookies: { session_token: 'valid' } });
      await pre.canActivate(context);
      await asUser(`emp-${i % 3}`, () => user.canActivate(context));
      if (i % 2 === 0) response.raw.emit('close'); // half abort; the other half are open streams
    }

    expect(cache.live('IP:203.0.113.9', 0)).toHaveLength(0);
    expect(cache.refundRateLimit).toHaveBeenCalledTimes(500);
  });

  it('keeps the address slot of an UNVERIFIED request that ends in a non-401 (a forged cookie, a 5xx from identity)', async () => {
    const cache = windowCache();
    const pre = new RateLimitGuard(reflectorFor() as never, cache as never);
    const { context, finish } = contextFor({ cookies: { session_token: 'forged' } });

    await pre.canActivate(context);
    finish(200); // identity never verified the caller, so nothing gives the slot back
    finish(500);

    expect(cache.refundRateLimit).not.toHaveBeenCalled();
    expect(cache.live('IP:203.0.113.9', 0)).toHaveLength(1);
  });

  it('keeps the address slot of a request on a route with no principal (a future @Public() route)', async () => {
    const cache = windowCache();
    const pre = new RateLimitGuard(reflectorFor() as never, cache as never);
    const user = new UserRateLimitGuard(reflectorFor() as never, cache as never);
    const { context, finish } = contextFor({ cookies: { session_token: 'anonymous' } });

    await pre.canActivate(context);
    await user.canActivate(context); // no principal: this guard leaves the slot alone
    finish(200);

    expect(cache.refundRateLimit).not.toHaveBeenCalled();
    expect(cache.live('IP:203.0.113.9', 0)).toHaveLength(1);
  });

  it('still admits the request when the refund fails, logs the error, and leaves the slot in place', async () => {
    const cache = windowCache();
    cache.refundRateLimit.mockImplementationOnce(() =>
      Promise.reject(new Error('valkey went away')),
    );
    const pre = new RateLimitGuard(reflectorFor() as never, cache as never);
    const user = new UserRateLimitGuard(reflectorFor() as never, cache as never);
    const log = vi.fn();
    (user as unknown as { logger: { error: typeof log } }).logger.error = log;
    const { context } = contextFor({ cookies: { session_token: 'valid' } });

    await pre.canActivate(context);
    await expect(asUser('emp-1', () => user.canActivate(context))).resolves.toBe(true);
    await new Promise((resolve) => setImmediate(resolve)); // let the rejected refund settle

    expect(log).toHaveBeenCalledWith(expect.anything(), 'RateLimitGuard: slot not refunded');
    expect(cache.live('IP:203.0.113.9', 0)).toHaveLength(1);
  });

  it('a request that never reaches identity and then aborts still holds its slot (a probe is counted)', async () => {
    const cache = windowCache();
    const pre = new RateLimitGuard(reflectorFor() as never, cache as never);
    const { context, response } = contextFor({ cookies: { session_token: 'probe' } });

    await pre.canActivate(context);
    response.raw.emit('close');

    expect(cache.live('IP:203.0.113.9', 0)).toHaveLength(1);
  });

  it('keeps the slot for a failed authentication (401), and never refunds it', async () => {
    const cache = windowCache();
    const guard = new RateLimitGuard(reflectorFor() as never, cache as never);
    const { context, finish } = contextFor({ cookies: { session_token: 'random' } });

    await guard.canActivate(context);
    finish(401);

    expect(cache.refundRateLimit).not.toHaveBeenCalled();
    expect(cache.live('IP:203.0.113.9', 0)).toHaveLength(1);
  });

  it('keeps the slot when the socket closes before the reply finishes (an aborted request still counts)', async () => {
    const cache = windowCache();
    const guard = new RateLimitGuard(reflectorFor() as never, cache as never);
    const { context, response } = contextFor({ cookies: { session_token: 'random' } });

    await guard.canActivate(context);
    // An aborted connection emits 'close' and never 'finish': no refund hook runs.
    response.raw.emit('close');

    expect(cache.refundRateLimit).not.toHaveBeenCalled();
    expect(cache.live('IP:203.0.113.9', 0)).toHaveLength(1);
  });

  it('refuses before the request runs once the failures fill the window, and counts the refused request for nothing', async () => {
    const cache = windowCache();
    const guard = new RateLimitGuard(reflectorFor() as never, cache as never);

    for (let i = 0; i < PRE_AUTH_IP_BUCKET.limit; i++) {
      const { context, finish } = contextFor({ cookies: { session_token: `random-${i}` } });
      await guard.canActivate(context);
      finish(401);
    }

    const next = contextFor({ cookies: { session_token: 'one-more' } });
    const refused = await guard.canActivate(next.context).catch((err: unknown) => err);
    expect((refused as HttpException).getStatus()).toBe(429);
    expect(cache.live('IP:203.0.113.9', 0)).toHaveLength(PRE_AUTH_IP_BUCKET.limit);
  });

  it('admits EXACTLY the limit of a parallel burst of failing requests, not all of them', async () => {
    const cache = windowCache();
    const guard = new RateLimitGuard(
      reflectorFor() as never,
      cache as never,
      {
        get: vi.fn(() => 30),
      } as never,
    );

    // 500 requests start before any reply finishes: the reservations are atomic, so only 30 get a slot.
    const replies = Array.from({ length: 500 }, () =>
      contextFor({ cookies: { session_token: 'random' } }),
    );
    const outcomes = await Promise.all(
      replies.map(({ context }) =>
        guard.canActivate(context).then(
          () => 'through',
          () => 'refused',
        ),
      ),
    );

    expect(outcomes.filter((o) => o === 'through')).toHaveLength(30);
    expect(outcomes.filter((o) => o === 'refused')).toHaveLength(470);
  });

  it('gives two addresses two windows', async () => {
    const cache = windowCache();
    const guard = new RateLimitGuard(reflectorFor() as never, cache as never);

    const a = contextFor({ ip: '198.51.100.1' });
    await guard.canActivate(a.context);
    a.finish(401);
    const b = contextFor({ ip: '198.51.100.2' });
    await guard.canActivate(b.context);
    b.finish(401);

    expect(cache.consumeRateLimit.mock.calls.map((call) => call[0])).toEqual([
      'IP:198.51.100.1',
      'IP:198.51.100.2',
    ]);
  });

  it('never sets the KEYED_BY_ADDRESS marker: that is for the per-user bucket, which could not key the caller', async () => {
    const guard = new RateLimitGuard(reflectorFor() as never, windowCache() as never);
    const { context, request } = contextFor();

    await guard.canActivate(context);

    expect((request as unknown as Record<symbol, unknown>)[KEYED_BY_ADDRESS]).toBeUndefined();
  });

  describe('the address comes from clientIp(), never from a header the caller can choose', () => {
    const keyFor = async (headers: Record<string, string>, ip = '10.0.0.1') => {
      const cache = windowCache();
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

    it('x-forwarded-for is not read either (platform-http 5.0.2): the socket decides', async () => {
      // Before 5.0.2 the chain's FIRST entry was the fallback, so a caller without cf-connecting-ip
      // chose its own bucket. Now the socket address is the answer for both headers.
      expect(await keyFor({ 'x-forwarded-for': '198.51.100.99' })).toBe('IP:10.0.0.1');
      expect(await keyFor({ 'x-forwarded-for': '198.51.100.100' })).toBe('IP:10.0.0.1');
    });

    it('a header value that is not an IP address is skipped, not used as a key', async () => {
      expect(await keyFor({ 'cf-connecting-ip': 'not-an-ip\r\nx' })).toBe('IP:10.0.0.1');
    });
  });

  it('throws a flat body the exception filter can read the message out of', async () => {
    const cache = windowCache();
    cache.sets.set(
      'rl:IP:203.0.113.9',
      Array.from({ length: PRE_AUTH_IP_BUCKET.limit }, (_, i) => ({ id: `s${i}`, at: Date.now() })),
    );
    const guard = new RateLimitGuard(reflectorFor() as never, cache as never);

    const thrown = await guard.canActivate(contextFor().context).catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(HttpException);

    const body = (thrown as HttpException).getResponse() as Record<string, unknown>;
    // FLAT: a nested `{ error: { message } }` is what produced the `"Error"` message.
    expect(body.error, 'the body must not nest another envelope inside itself').toBeUndefined();
    expect(body.message).toMatch(/Too many requests — retry after \d+s\./);
    expect(body.retryAfter).toBeGreaterThan(0);
    expect(GlobalExceptionFilter).toBeTypeOf('function');
  });

  it('applies RATE_LIMIT_IP_LIMIT when configured, and the shipped ceiling otherwise', async () => {
    const cache = windowCache();
    const config = { get: vi.fn(() => 2) };
    const guard = new RateLimitGuard(reflectorFor() as never, cache as never, config as never);

    for (let i = 0; i < 2; i++) {
      const { context, finish } = contextFor();
      await guard.canActivate(context);
      finish(401);
    }
    await expect(guard.canActivate(contextFor().context)).rejects.toMatchObject({ status: 429 });
  });

  it('fails open when the cache is down', async () => {
    const cache = { consumeRateLimit: vi.fn().mockRejectedValue(new Error('valkey down')) };
    const guard = new RateLimitGuard(reflectorFor() as never, cache as never);

    await expect(guard.canActivate(contextFor().context)).resolves.toBe(true);
  });

  it('takes no slot and refunds nothing when the cache is disabled (no id)', async () => {
    const cache = {
      consumeRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 1, resetAt: 0 }),
      refundRateLimit: vi.fn(),
    };
    const guard = new RateLimitGuard(reflectorFor() as never, cache as never);
    const { context, finish } = contextFor();

    await guard.canActivate(context);
    finish(200);

    expect(cache.refundRateLimit).not.toHaveBeenCalled();
  });

  it('honours @SkipRateLimit()', async () => {
    const cache = windowCache();
    const guard = new RateLimitGuard(reflectorFor({ skip: true }) as never, cache as never);
    const { context, finish } = contextFor();

    await expect(guard.canActivate(context)).resolves.toBe(true);
    finish(401);
    expect(cache.consumeRateLimit).not.toHaveBeenCalled();
  });
});

describe('UserRateLimitGuard (authenticated, per user)', () => {
  // A counting cache for the per-user bucket: admits up to `limit` per key in the window.
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

  it('counts an authenticated caller against uid:<userId>, with the route tier', async () => {
    const cache = countingCache();
    const guard = new UserRateLimitGuard(reflectorFor() as never, cache as never);

    await asUser('emp-1', () => guard.canActivate(contextFor().context));

    expect(cache.consumeRateLimit.mock.calls[0][0]).toBe('DEFAULT:uid:emp-1');
  });

  it('gives every cookie variant of one signed-in session the same user bucket', async () => {
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

  it('marks a request with no principal, so identity can warn when this guard ran before its SessionGuard', async () => {
    const cache = countingCache();
    const guard = new UserRateLimitGuard(reflectorFor() as never, cache as never);
    const { context, request } = contextFor();

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(cache.consumeRateLimit).not.toHaveBeenCalled();
    expect((request as unknown as Record<symbol, unknown>)[KEYED_BY_ADDRESS]).toBe(true);
  });

  it('does not mark an authenticated request: its principal is there, so there is nothing to warn about', async () => {
    const cache = countingCache();
    const guard = new UserRateLimitGuard(reflectorFor() as never, cache as never);
    const { context, request } = contextFor();

    await asUser('emp-1', () => guard.canActivate(context));

    expect((request as unknown as Record<symbol, unknown>)[KEYED_BY_ADDRESS]).toBeUndefined();
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
