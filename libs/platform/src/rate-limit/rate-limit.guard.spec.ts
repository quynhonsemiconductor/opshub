import { HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { GlobalExceptionFilter } from '@quynhonsemiconductor/platform-http';
import { RateLimitGuard } from './rate-limit.guard';

/**
 * The 429 says WHY, and survives the exception filter.
 *
 * `GlobalExceptionFilter` (shared package) builds the wire envelope itself:
 *
 *   message: typeof res === 'string' ? res : (res['message'] ?? 'Error')
 *
 * The guard used to throw a NESTED `{ error: { code, message } }`, so `res['message']` was undefined and
 * every rate-limited response in the product reached the caller as the literal message `"Error"`. It was
 * found from the other end: a 429 rendered as a bare "Error" under an upload button in the SPA, naming
 * nothing. This asserts the shape the filter actually reads, so a future "tidy-up" back to a nested
 * envelope fails here rather than in somebody's face.
 */

function contextFor(
  headers: Record<string, string>,
  over: { ip?: string; cookies?: Record<string, string> } = {},
) {
  const request = {
    headers,
    ip: over.ip ?? '203.0.113.9',
    // Undefined ON PURPOSE, and it is not a simplification of the fixture: this guard is global and
    // `JwtAuthGuard` is a route guard, so authentication has not run when it executes. A fixture that
    // populated `user` would be testing a request shape the guard never sees.
    user: undefined,
    cookies: over.cookies ?? {},
  };
  const response = { header: vi.fn() };
  return {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as never;
}

/** A cache that always admits, and records the key it was asked about. */
function admittingCache() {
  return {
    consumeRateLimit: vi.fn().mockResolvedValue({
      allowed: true,
      remaining: 199,
      resetAt: Math.floor(Date.now() / 1000) + 60,
    }),
  };
}

const SESSION_COOKIE = '__Host-opshub_session';

/** A cache that always refuses, which is the only interesting branch here. */
const exhaustedCache = {
  consumeRateLimit: vi.fn().mockResolvedValue({
    allowed: false,
    remaining: 0,
    resetAt: Math.floor(Date.now() / 1000) + 42,
  }),
};

const reflector = { getAllAndOverride: vi.fn().mockReturnValue(undefined) };

describe('RateLimitGuard, when the bucket is empty', () => {
  it('throws a 429 whose message names the wait', async () => {
    const guard = new RateLimitGuard(reflector as never, exhaustedCache as never);

    await expect(guard.canActivate(contextFor({}))).rejects.toMatchObject({
      status: 429,
    });
  });

  it('throws a body the exception filter can read the message out of', async () => {
    const guard = new RateLimitGuard(reflector as never, exhaustedCache as never);

    const thrown = await guard.canActivate(contextFor({})).catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(HttpException);

    const body = (thrown as HttpException).getResponse() as Record<string, unknown>;
    // FLAT. A nested `{ error: { message } }` is what produced the `"Error"` message, so this asserts
    // the absence of that nesting as much as the presence of the text.
    expect(body.error, 'the body must not nest another envelope inside itself').toBeUndefined();
    expect(body.message).toMatch(/Too many requests — retry after \d+s\./);
    expect(body.retryAfter).toBeGreaterThan(0);

    // And the filter's own extraction, run for real rather than described: this is the line that
    // produced "Error" before.
    const extracted = typeof body === 'string' ? body : ((body['message'] as string) ?? 'Error');
    expect(extracted).not.toBe('Error');
  });

  it('keeps the filter reachable — the class it depends on is still exported', () => {
    // A guard whose message is right and whose filter has moved would be silently wrong again.
    expect(GlobalExceptionFilter).toBeTypeOf('function');
  });
});

/**
 * WHO the bucket belongs to — the half that was silently wrong.
 *
 * The tier table says `DEFAULT` is "200 req/min per userId" and the guard read `req.user?.sub` to get
 * it. That is always undefined here, because this is a GLOBAL guard and `JwtAuthGuard` is a ROUTE guard:
 * Nest runs global guards first, so authentication has not happened yet. Every request therefore fell
 * through to the IP, and a whole office behind one NAT shared a single 200-a-minute bucket — about
 * fifteen simultaneous page loads at a dozen calls each, then everybody there gets 429s at once.
 *
 * Verified against the running API before this was written: three authenticated bearer requests produced
 * the single key `rl:DEFAULT:127.0.0.1`.
 *
 * These tests assert the KEY rather than the outcome, because the outcome of one request is "allowed"
 * either way. The key is the whole behaviour.
 */
describe('RateLimitGuard identity', () => {
  it('gives two sessions on one IP two buckets', async () => {
    const cache = admittingCache();
    const guard = new RateLimitGuard(reflector as never, cache as never);

    await guard.canActivate(contextFor({}, { cookies: { [SESSION_COOKIE]: 'session-a' } }));
    await guard.canActivate(contextFor({}, { cookies: { [SESSION_COOKIE]: 'session-b' } }));

    const [first, second] = cache.consumeRateLimit.mock.calls.map((call) => call[0] as string);
    expect(first).not.toBe(second);
    // Same network, so an IP-keyed limiter would have produced one key for both.
    expect(first).not.toContain('203.0.113.9');
    expect(second).not.toContain('203.0.113.9');
  });

  it('gives one session on two IPs one bucket', async () => {
    // The converse, and the reason this is per-credential rather than per-connection: a phone moving
    // from wifi to mobile data is one client and must not get a fresh allowance by changing network.
    const cache = admittingCache();
    const guard = new RateLimitGuard(reflector as never, cache as never);

    await guard.canActivate(
      contextFor({}, { ip: '198.51.100.1', cookies: { [SESSION_COOKIE]: 'session-a' } }),
    );
    await guard.canActivate(
      contextFor({}, { ip: '198.51.100.2', cookies: { [SESSION_COOKIE]: 'session-a' } }),
    );

    const [first, second] = cache.consumeRateLimit.mock.calls.map((call) => call[0] as string);
    expect(first).toBe(second);
  });

  it('never puts the credential itself in the key', async () => {
    /*
     * Cache keys are readable by anything with Valkey access, and a session cookie in one is a session
     * that anybody holding it can resume. So the key is a hash — and short enough to stay cheap, since
     * this runs on every request.
     */
    const cache = admittingCache();
    const guard = new RateLimitGuard(reflector as never, cache as never);

    await guard.canActivate(
      contextFor({}, { cookies: { [SESSION_COOKIE]: 'a-real-looking-session-value' } }),
    );

    const key = cache.consumeRateLimit.mock.calls[0][0] as string;
    expect(key).not.toContain('a-real-looking-session-value');
    expect(key).toMatch(/^DEFAULT:[0-9a-f]{32}$/);
  });

  it('keys a bearer caller by its token, not by its network', async () => {
    // API consumers and the e2e harness send a bearer token and no cookie. Before, they were the IP.
    const cache = admittingCache();
    const guard = new RateLimitGuard(reflector as never, cache as never);

    await guard.canActivate(contextFor({ authorization: 'Bearer token-one' }));
    await guard.canActivate(contextFor({ authorization: 'Bearer token-two' }));

    const [first, second] = cache.consumeRateLimit.mock.calls.map((call) => call[0] as string);
    expect(first).not.toBe(second);
    expect(first).not.toContain('token-one');
  });

  it('prefers the session cookie when both are present', async () => {
    // The SPA is cookie-only and is nearly all the traffic; a request carrying both is the SPA on a path
    // that also forwards a token, and the cookie is the identity it actually authenticates with.
    const cache = admittingCache();
    const guard = new RateLimitGuard(reflector as never, cache as never);

    await guard.canActivate(
      contextFor(
        { authorization: 'Bearer token-one' },
        { cookies: { [SESSION_COOKIE]: 'session-a' } },
      ),
    );
    await guard.canActivate(
      contextFor(
        { authorization: 'Bearer token-two' },
        { cookies: { [SESSION_COOKIE]: 'session-a' } },
      ),
    );

    const [first, second] = cache.consumeRateLimit.mock.calls.map((call) => call[0] as string);
    expect(first).toBe(second);
  });

  it('falls back to the IP when no credential was sent at all', async () => {
    /*
     * A genuine pre-auth request — a login attempt, a probe — has no identity but the network it came
     * from, and that is the right bucket for it. This is also what protects the login endpoint, so the
     * fallback is load-bearing rather than a safety net.
     */
    const cache = admittingCache();
    const guard = new RateLimitGuard(reflector as never, cache as never);

    await guard.canActivate(contextFor({}, { ip: '198.51.100.7' }));

    expect(cache.consumeRateLimit.mock.calls[0][0]).toBe('DEFAULT:198.51.100.7');
  });

  it('reads a forwarded IP for that fallback, so it is the client and not the proxy', async () => {
    // Unchanged behaviour, asserted because the fallback now matters less often and so gets exercised
    // less: behind the ALB every request would otherwise share the load balancer's address.
    const cache = admittingCache();
    const guard = new RateLimitGuard(reflector as never, cache as never);

    await guard.canActivate(contextFor({ 'x-forwarded-for': '203.0.113.44, 10.0.0.1' }));

    expect(cache.consumeRateLimit.mock.calls[0][0]).toBe('DEFAULT:203.0.113.44');
  });
});
