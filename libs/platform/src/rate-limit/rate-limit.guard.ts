import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { AppConfigService } from '../config/app-config.service';
import { CacheService } from '@quynhonsemiconductor/platform-cache';
import { KEYED_BY_ADDRESS, clientIp, currentUserId } from '@quynhonsemiconductor/platform-http';
import {
  RATE_LIMIT_TIER,
  SKIP_RATE_LIMIT,
  RATE_LIMIT_TIERS,
  type RateLimitTierName,
} from './rate-limit.constants';
import { SESSION_COOKIE } from '../auth/session-cookie';
import { failOpenLog } from '@quynhonsemiconductor/observability';

/**
 * Global rate-limit guard backed by the shared sliding-window limiter
 * (@quynhonsemiconductor/platform-cache `consumeRateLimit`, an atomic sorted-set log). rally
 * and opshub share the same limiter mechanism; only the tiers/policy differ.
 *
 * WHY THIS DOES NOT READ `req.user`, AND WHY IT USED TO TRY.
 *
 * This is a GLOBAL guard (`APP_GUARD`). `SessionAuthGuard` is a ROUTE guard, mounted by `@Auth()` and
 * `@RequirePermission()`. Nest runs global guards first, so authentication has not happened yet when
 * this executes and `req.user` is always undefined — on every request, including fully authenticated
 * ones.
 *
 * The identifier therefore fell through to the IP for every tier, and the three
 * docblocks describing a "NAT-safe per-user bucket" described something that never happened. What
 * actually happened: everybody behind one office NAT shared a single 200-requests-a-minute bucket. At
 * roughly a dozen API calls per page load that is about fifteen simultaneous page loads for the whole
 * company before the next person gets a 429 — and the refusal lands on whichever request is next, so it
 * presents as an unrelated feature breaking.
 *
 * SO THE IDENTITY COMES FROM THE CREDENTIAL, not from the decoded principal. The session cookie is a
 * per-session secret the caller has already sent, and hashing it gives a stable bucket without verifying
 * anything. A forged or garbage credential simply gets its own bucket rather than somebody else's.
 *
 * PER SESSION, NOT PER USER, and that is the honest description: one person in two browsers holds two
 * sessions and gets two buckets. For a limiter whose job is to bound the damage one client can do, the
 * client is the session.
 *
 * Key strategy (controlled by tier.keyBy):
 *  - 'userId'       — the caller's session cookie, hashed; NAT-safe (default)
 *  - 'ip'           — pre-auth requests where no credential exists yet (AUTH_LOGIN)
 *  - fallback: the credential if one was sent, else the IP
 *
 *  - Graceful degradation: if Redis is unavailable, allow request through
 *  - RFC 6585 + draft-ietf-httpapi-ratelimit-headers compliant response headers
 */
/**
 * A stable, opaque bucket id for a secret the caller sent.
 *
 * Hashed so no credential ever appears in a cache key — the keys are readable by anything with Valkey
 * access, and a session cookie in one is a session anybody holding it can resume. Truncated to 32 hex
 * characters: 128 bits is far past collision relevance for a keyspace that expires every minute, and a
 * shorter key is a smaller cache entry on a hot path.
 */
function hashCredential(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 32);
}

/**
 * The caller's credential, hashed: the identity session cookie, the only credential there is.
 *
 * Returns undefined when it is absent, which is a genuine pre-auth request (a sign-in attempt, a health
 * probe), and those belong on the IP.
 */
function credentialOf(req: FastifyRequest): string | undefined {
  const session = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
  return session ? hashCredential(session) : undefined;
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly cache: CacheService,
    /**
     * Optional so the guard can still be constructed in a unit test with two arguments — and so a host
     * that never registers the config module keeps the shipped ceiling rather than failing to boot.
     */
    private readonly config?: AppConfigService,
  ) {}

  /**
   * The tier's ceiling, with the DEFAULT tier's read from config.
   *
   * Only the DEFAULT tier is configurable, and only downwards in production (the env schema refuses a
   * higher value there). Every other tier — AUTH_LOGIN, UPLOAD, AI — is fixed in code, because those
   * protect specific abuse paths rather than absorbing ordinary traffic.
   */
  private limitFor(tierName: RateLimitTierName, tier: { limit: number }): number {
    if (tierName !== 'DEFAULT') return tier.limit;
    return this.config?.get('RATE_LIMIT_DEFAULT_LIMIT') ?? tier.limit;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_RATE_LIMIT, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return true;

    const tierName =
      this.reflector.getAllAndOverride<RateLimitTierName>(RATE_LIMIT_TIER, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'DEFAULT';
    const tier = RATE_LIMIT_TIERS[tierName] as import('./rate-limit.constants').RateLimitTier;

    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const res = context.switchToHttp().getResponse<FastifyReply>();

    // The principal, from the request context. Nothing here reads `req.user`: that is set by SessionAuthGuard,
    // which runs after this global guard, so `userId` is undefined on today's routes (see the docblock above).
    const userId = currentUserId();
    // `clientIp()`, never a header read here: behind Cloudflare `x-real-ip` and the first `x-forwarded-for` entry
    // are whatever the caller chose to send, so a forged one would pick its own rate-limit bucket. It returns the
    // signed edge address when `EDGE_CLIENT_IP_SECRET` is set, else `cf-connecting-ip`, else the socket.
    const ip = clientIp(req);

    let identifier: string;
    switch (tier.keyBy) {
      case 'ip':
        identifier = ip;
        break;
      case 'userId':
      default:
        /*
         * `userId` FIRST so this keeps working if the guard is ever ordered after authentication — but it
         * is undefined today, for the reason in the class docblock, so the credential is what actually
         * carries the bucket. IP remains the last resort: a caller who sent no credential at all has no
         * other identity to be keyed on.
         */
        identifier = userId ? `uid:${userId}` : (credentialOf(req) ?? ip);
    }
    // Marks a caller keyed by address (one bucket per NAT) so identity's SessionGuard can warn when it runs after
    // this guard. A session-keyed caller is not marked: its bucket is its own.
    if (!userId && identifier === ip)
      (req as unknown as Record<symbol, unknown>)[KEYED_BY_ADDRESS] = true;
    const rateLimitKey = `${tierName}:${identifier}`;

    // Consume one slot from the shared sliding-window limiter. The tier window is
    // defined in ms; the shared primitive takes seconds. When the cache is
    // disabled (optional mode) consumeRateLimit fails open (allowed = true).
    let allowed: boolean;
    let remaining: number;
    let resetAt: number;
    try {
      ({ allowed, remaining, resetAt } = await this.cache.consumeRateLimit(
        rateLimitKey,
        this.limitFor(tierName, tier),
        Math.ceil(tier.windowMs / 1000),
      ));
    } catch (err) {
      // Rate limiting is a protective control, not a hard dependency for serving
      // traffic. If the cache is unavailable, fail open and surface it via logs.
      this.logger.error(
        failOpenLog('rate_limit', { err, key: rateLimitKey }),
        'RateLimitGuard: backend unavailable — allowing request',
      );
      return true;
    }

    // RFC 6585 headers on every response
    void res.header('RateLimit-Limit', this.limitFor(tierName, tier));
    void res.header('RateLimit-Remaining', Math.max(0, remaining));
    void res.header('RateLimit-Reset', resetAt);

    if (!allowed) {
      const retryAfterSecs = Math.max(resetAt - Math.floor(Date.now() / 1000), 1);
      void res.header('Retry-After', retryAfterSecs);
      /**
       * A FLAT response body, because that is the only shape the exception filter reads.
       *
       * `GlobalExceptionFilter` builds the envelope itself:
       *
       *   message: typeof res === 'string' ? res : (res['message'] ?? 'Error')
       *
       * This threw a nested `{ error: { code, message } }`, so `res['message']` was undefined and EVERY
       * rate-limited response in the product reached the caller as the message `"Error"` — measured on a
       * 429 that surfaced in the SPA as a bare "Error" under an upload button, which cost real time to
       * diagnose because it names nothing. The `code` is not lost by flattening: the filter derives it
       * from the status, and `httpStatusToErrorCode(429)` is `RATE_LIMITED`.
       */
      throw new HttpException(
        {
          message: `Too many requests — retry after ${retryAfterSecs}s.`,
          retryAfter: retryAfterSecs,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }
}
