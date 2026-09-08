import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { Observable, from } from 'rxjs';
import { switchMap, tap } from 'rxjs/operators';
import { CacheService } from '@quynhonsemiconductor/platform-cache';
import { ConflictException, ValidationException } from '../errors/exceptions';
import { ErrorCodes } from '../errors/error-codes';
import type { JwtPayload } from '../auth/jwt.strategy';

/** How long a completed response stays replayable. A retry window, not a cache. */
const IDEMPOTENCY_TTL_SECONDS = 24 * 3600;

/**
 * How long the in-flight marker survives without the request finishing.
 *
 * Longer than any request the API will serve — the ALB idle timeout is 60s — so a client retrying
 * after ITS timeout is still told "in flight" rather than being let through to run a second copy.
 * Short enough that a pod killed mid-request does not lock the key out for the whole TTL.
 */
const IN_FLIGHT_TTL_MS = 90_000;

/** GET and DELETE are idempotent by definition; there is nothing for a key to add. */
const IDEMPOTENT_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/** The header a client sends, and the one it reads back to learn the response was a replay. */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
export const IDEMPOTENCY_REPLAYED_HEADER = 'x-idempotent-replayed';

/** What is stored per key: the answer, and enough to know the question was the same one. */
interface IdempotentRecord {
  /** SHA-256 of method + path + body. */
  fingerprint: string;
  body: unknown;
}

/**
 * Replays the response to a retried mutation instead of performing it twice.
 *
 * WHAT THIS WAS BEFORE. It existed, was registered globally, and could not be reached. `Idempotency-Key`
 * was absent from the CORS `allowedHeaders`, so a browser preflight rejected the request before it was
 * sent; `X-Idempotent-Replayed` was absent from `exposedHeaders`, so a browser could not have read the
 * answer even if it had arrived. Nothing sent the header, nothing documented it, nothing tested it. The
 * code implied a guarantee the API did not make — which is worse than not having it, because a client
 * team told "just send Idempotency-Key" would hit a CORS failure that says nothing about why.
 *
 * WHAT MAKES IT A GUARANTEE RATHER THAN A RESPONSE CACHE
 *
 *  1. THE BODY IS FINGERPRINTED. The same key with a different body is a client bug, and serving the
 *     first request's response would report success for work that was never done. That is refused
 *     (`IDEMPOTENCY_KEY_REUSED`, 422) rather than answered.
 *
 *  2. CONCURRENT COPIES ARE SERIALISED. A lock is taken before the handler runs, so the case the header
 *     exists for — a client timed out and retried while the first request is still going — does not
 *     execute the mutation twice. The second is told to retry (`IDEMPOTENCY_IN_FLIGHT`, 409). Without
 *     this the interceptor only helped a retry that arrived AFTER the first one finished, which is the
 *     easy half of the problem.
 *
 *  3. ONLY SUCCESSES ARE STORED. A failed request leaves nothing behind, so retrying it re-executes —
 *     which is what a client wants after a 500, and the opposite of what caching the failure would do.
 *
 * SCOPED PER IDENTITY, so one caller's key cannot collide with or read another's.
 *
 * Skipped entirely when: the method is GET or DELETE, no key is present (opt-in), or the cache is
 * unavailable. The last is deliberate — degrading to "perform the request" keeps the API working when
 * Valkey is down, at the cost of the guarantee, and the alternative is refusing every mutation.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(private readonly cache: CacheService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const req = context.switchToHttp().getRequest<FastifyRequest & { user?: JwtPayload }>();
    const res = context.switchToHttp().getResponse<FastifyReply>();

    if (!IDEMPOTENT_METHODS.has(req.method.toUpperCase())) return next.handle();

    const key = req.headers[IDEMPOTENCY_KEY_HEADER] as string | undefined;
    if (!key || !this.cache.isAvailable) return next.handle();

    // Identity first so keys are per-caller. `req.user` is populated: guards run before interceptors.
    const identity = req.user?.sub ?? req.ip ?? 'anon';
    const cacheKey = `idem:${identity}:${key}`;
    const lockKey = `${cacheKey}:lock`;
    const fingerprint = this.fingerprint(req);

    return from(this.cache.getJson<IdempotentRecord>(cacheKey)).pipe(
      switchMap((stored) => {
        if (stored) return from([this.replay(stored, fingerprint, res)]);

        return from(this.cache.acquireLock(lockKey, IN_FLIGHT_TTL_MS)).pipe(
          switchMap((acquired) => {
            if (!acquired) {
              /*
               * Somebody else is running this exact request. NOT served the stored response, because
               * there is none yet — the first copy has not finished. Telling the client to retry is
               * the only honest answer, and it is the answer that stops a double charge.
               */
              throw new ConflictException(
                ErrorCodes.IDEMPOTENCY_IN_FLIGHT,
                'A request with this Idempotency-Key is still in progress. Retry shortly.',
              );
            }

            return next.handle().pipe(
              tap((body) => {
                // Stored only on success: `tap` does not run when the handler throws, so a failed
                // mutation stays retryable.
                void this.cache.setJson<IdempotentRecord>(
                  cacheKey,
                  { fingerprint, body },
                  IDEMPOTENCY_TTL_SECONDS,
                );
              }),
              // The lock is released either way. Holding it after a failure would lock the client out
              // of the retry it is entitled to for the next ninety seconds.
              tap({
                next: () => void this.cache.releaseLock(lockKey),
                error: () => void this.cache.releaseLock(lockKey),
              }),
            );
          }),
        );
      }),
    );
  }

  /**
   * The stored answer, or a refusal if the question changed.
   *
   * METHOD AND PATH ARE PART OF THE FINGERPRINT, not just the body: the same key on a different route
   * is a different request, and an empty-bodied `POST /x/activate` and `POST /y/activate` would
   * otherwise hash identically.
   */
  private replay(stored: IdempotentRecord, fingerprint: string, res: FastifyReply): unknown {
    if (stored.fingerprint !== fingerprint) {
      throw new ValidationException(
        ErrorCodes.IDEMPOTENCY_KEY_REUSED,
        'This Idempotency-Key was already used for a different request.',
      );
    }
    void res.header(IDEMPOTENCY_REPLAYED_HEADER, 'true');
    this.logger.debug({ replayed: true }, 'Idempotent replay');
    return stored.body;
  }

  private fingerprint(req: FastifyRequest): string {
    return createHash('sha256')
      .update(`${req.method}\n${req.url}\n${JSON.stringify(req.body ?? null)}`)
      .digest('hex');
  }
}
