import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { AppConfigService } from '../config/app-config.service';
import { CacheService } from '@quynhonsemiconductor/platform-cache';
import { KEYED_BY_ADDRESS, clientIp, currentUserId } from '@quynhonsemiconductor/platform-http';
import {
  PRE_AUTH_IP_BUCKET,
  RATE_LIMIT_TIER,
  SKIP_RATE_LIMIT,
  RATE_LIMIT_TIERS,
  type RateLimitTier,
  type RateLimitTierName,
} from './rate-limit.constants';
import { failOpenLog } from '@quynhonsemiconductor/observability';

/**
 * Two buckets, and neither is keyed by a cookie.
 *
 * 1. `RateLimitGuard` — GLOBAL, runs first, before any credential is read. Reserves a slot against the verified
 *    client address (`clientIp()`: the signed edge address, else `cf-connecting-ip`, else the socket) for every request.
 *    The slot is given back only once identity has verified the caller (`UserRateLimitGuard`). Every other request keeps
 *    it, so the NAT-sized {@link PRE_AUTH_IP_BUCKET} counts unverified requests: failed authentications, forged cookies,
 *    and requests that never reach identity.
 *
 * 2. `UserRateLimitGuard` — GLOBAL, registered in a module imported AFTER the identity module, so it runs after
 *    identity's `SessionGuard` has verified the session and recorded the principal. It counts an authenticated
 *    caller against `uid:<userId>` with the route's tier. A request with no principal (public route, or refused
 *    by identity) has no user bucket and is left to bucket 1.
 *
 * Why not the session cookie: the cookie is a secret the caller chooses, and before identity reads it nothing
 * says it is valid. A per-cookie bucket let a caller mint a fresh bucket with each random cookie (the per-IP
 * limit was bypassed and Valkey keys grew without bound), and one signed-in session could appear as several
 * buckets through cookie encoding variants. Keying on the verified identity fixes both.
 *
 * Graceful degradation: if the cache is unavailable the request is allowed (fail open, logged).
 * Responses carry RFC 6585 + draft-ietf-httpapi-ratelimit-headers headers.
 */

/** The RFC 6585 + draft-ietf-httpapi-ratelimit-headers values for the bucket that answered. */
function setHeaders(res: FastifyReply, limit: number, remaining: number, resetAt: number): void {
  void res.header('RateLimit-Limit', limit);
  void res.header('RateLimit-Remaining', Math.max(0, remaining));
  void res.header('RateLimit-Reset', resetAt);
}

/** Consumes one slot from a bucket. Returns the response headers' values, or throws 429 when the bucket is empty. */
async function consume(
  cache: CacheService,
  logger: Logger,
  res: FastifyReply,
  key: string,
  tier: RateLimitTier,
  limit: number,
): Promise<true> {
  // The shared primitive takes seconds; the tier window is defined in ms.
  let allowed: boolean;
  let remaining: number;
  let resetAt: number;
  try {
    ({ allowed, remaining, resetAt } = await cache.consumeRateLimit(
      key,
      limit,
      Math.ceil(tier.windowMs / 1000),
    ));
  } catch (err) {
    // Rate limiting is a protective control, not a hard dependency for serving traffic. If the cache is
    // unavailable, fail open and surface it via logs.
    logger.error(
      failOpenLog('rate_limit', { err, key }),
      'RateLimitGuard: backend unavailable — allowing request',
    );
    return true;
  }

  setHeaders(res, limit, remaining, resetAt);
  if (!allowed) refuse(res, resetAt);
  return true;
}

/** Writes Retry-After and throws the 429. Shared by both buckets, so the refusal reads the same from either. */
function refuse(res: FastifyReply, resetAt: number): never {
  const retryAfterSecs = Math.max(resetAt - Math.floor(Date.now() / 1000), 1);
  void res.header('Retry-After', retryAfterSecs);
  /**
   * A FLAT response body, because that is the only shape the exception filter reads: it builds the envelope
   * from `res['message']`. A nested `{ error: { message } }` made every rate-limited response read "Error".
   * The `code` is derived by the filter from the status (429 -> RATE_LIMITED).
   */
  throw new HttpException(
    {
      message: `Too many requests — retry after ${retryAfterSecs}s.`,
      retryAfter: retryAfterSecs,
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

/** A pre-auth slot taken for one request, and whether it has been given back. */
interface Reservation {
  key: string;
  id: string;
  settled: boolean;
}

/** Where the pre-auth guard leaves its reservation for the rest of the request. */
const PRE_AUTH_RESERVATION = Symbol('PRE_AUTH_RESERVATION');

/** Shared by both guards: the tier name a route declared, or DEFAULT. */
function tierOf(reflector: Reflector, context: ExecutionContext): RateLimitTierName {
  return (
    reflector.getAllAndOverride<RateLimitTierName>(RATE_LIMIT_TIER, [
      context.getHandler(),
      context.getClass(),
    ]) ?? 'DEFAULT'
  );
}

function skipped(reflector: Reflector, context: ExecutionContext): boolean {
  return Boolean(
    reflector.getAllAndOverride<boolean>(SKIP_RATE_LIMIT, [
      context.getHandler(),
      context.getClass(),
    ]),
  );
}

/**
 * Bucket 1: the pre-auth, per-address ceiling every request passes through first.
 *
 * It RESERVES a slot before the request runs. The slot is given back only once identity has verified the caller
 * (`UserRateLimitGuard`): a signed-in request then leaves no trace on the address. Every other request keeps its slot,
 * whatever status it ends with, so a forged cookie, a 5xx from identity, or a future public route is still counted
 * against its address. Reserving before the request is what makes a burst exact: the reservation is one atomic step on
 * the server, so N parallel requests admit exactly the limit, not all of them.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly cache: CacheService,
    // Optional, as on UserRateLimitGuard: a unit test or a host without the config module keeps the shipped ceiling.
    private readonly config?: AppConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (skipped(this.reflector, context)) return true;

    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const res = context.switchToHttp().getResponse<FastifyReply>();
    // `clientIp()`, never a header read here: behind Cloudflare `x-real-ip` and the first `x-forwarded-for` entry
    // are whatever the caller chose to send, so a forged one would pick its own bucket.
    const ip = clientIp(req);
    const key = `IP:${ip}`;
    const limit = this.config?.get('RATE_LIMIT_IP_LIMIT') ?? PRE_AUTH_IP_BUCKET.limit;
    const windowSeconds = Math.ceil(PRE_AUTH_IP_BUCKET.windowMs / 1000);

    let slot: Awaited<ReturnType<CacheService['consumeRateLimit']>>;
    try {
      slot = await this.cache.consumeRateLimit(key, limit, windowSeconds);
    } catch (err) {
      // Fail open, as everywhere in the limiter: a cache that cannot answer does not block traffic.
      this.logger.error(
        failOpenLog('rate_limit', { err, key }),
        'RateLimitGuard: backend unavailable — allowing request',
      );
      return true;
    }

    setHeaders(res, limit, slot.remaining, slot.resetAt);
    if (!slot.allowed) refuse(res, slot.resetAt);

    // No id: the cache is disabled, so no slot was taken and there is nothing to give back.
    const id = slot.id;
    if (id === undefined) return true;

    // Held on the request, so the per-user guard can settle it as soon as identity has verified the caller.
    const reservation: Reservation = { key, id, settled: false };
    (req as unknown as Record<symbol, unknown>)[PRE_AUTH_RESERVATION] = reservation;

    // Settled only by the per-user guard, once identity has verified the caller. Nothing else refunds it: an
    // unverified request keeps its slot whatever status it ends with (a forged cookie, a 5xx from identity, a route
    // that is not behind identity at all).
    return true;
  }
}

/** Gives a reserved slot back, once. A refund that fails is logged; the request has already been answered. */
export function refundReservation(
  cache: CacheService,
  logger: Logger,
  reservation: Reservation,
): void {
  if (reservation.settled) return;
  reservation.settled = true;
  cache
    .refundRateLimit(reservation.key, reservation.id)
    .catch((err: unknown) =>
      logger.error(
        failOpenLog('rate_limit', { err, key: reservation.key }),
        'RateLimitGuard: slot not refunded',
      ),
    );
}

/**
 * Bucket 2: the authenticated caller's own budget for the route's tier. Register it in a module imported AFTER
 * the identity module, so the principal is already in the request context when this runs.
 */
@Injectable()
export class UserRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(UserRateLimitGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly cache: CacheService,
    /**
     * Optional so the guard can be constructed in a unit test with three arguments, and so a host that never
     * registers the config module keeps the shipped ceiling rather than failing to boot.
     */
    private readonly config?: AppConfigService,
  ) {}

  /**
   * The tier's ceiling. Only the DEFAULT tier is configurable, and only downwards in production (the env schema
   * refuses a higher value there). Every other tier is fixed in code.
   */
  private limitFor(tierName: RateLimitTierName, tier: RateLimitTier): number {
    if (tierName !== 'DEFAULT') return tier.limit;
    return this.config?.get('RATE_LIMIT_DEFAULT_LIMIT') ?? tier.limit;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (skipped(this.reflector, context)) return true;

    const userId = currentUserId();
    if (!userId) {
      // No principal. On a public route that is expected. On a route that needs one it means this guard ran BEFORE identity's
      // SessionGuard, so the per-user bucket could not key the caller. The marker lets identity say so (its "too-late"
      // warning), and only when a principal is written after it: a public route never reaches that line.
      const req = context.switchToHttp().getRequest<Record<symbol, unknown>>();
      req[KEYED_BY_ADDRESS] = true;
      return true;
    }

    const req = context.switchToHttp().getRequest<Record<symbol, unknown>>();
    // Identity has verified the caller, so the address slot taken before identity ran is no longer needed. Giving it
    // back now (not when the reply finishes) keeps an open SSE stream or an aborted signed-in request from holding it.
    const reservation = req[PRE_AUTH_RESERVATION] as Reservation | undefined;
    if (reservation) refundReservation(this.cache, this.logger, reservation);

    const tierName = tierOf(this.reflector, context);
    const tier = RATE_LIMIT_TIERS[tierName] as RateLimitTier;
    const res = context.switchToHttp().getResponse<FastifyReply>();

    return consume(
      this.cache,
      this.logger,
      res,
      `${tierName}:uid:${userId}`,
      tier,
      this.limitFor(tierName, tier),
    );
  }
}
