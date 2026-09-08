import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { DomainException as SharedDomainException } from '@quynhonsemiconductor/platform-http';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { RequestContextService } from '../context/request-context';
import { albReceivedAtMs, albWaitMs, arrivalAtMs } from '@quynhonsemiconductor/platform-runtime';

/** Health/readiness probes — suppress from access logs to avoid noise. */
const SILENT_PREFIXES = ['/v1/healthz', '/v1/readyz', '/favicon.ico'];

/**
 * Resolve the status code for the access log from the THROWN error rather than
 * the reply, which the global exception filter has not written yet when this
 * interceptor's error tap fires. DomainException (opshub's own or any shared
 * `@quynhonsemiconductor/*` package's — all extend the shared base) exposes `httpStatus`;
 * Nest HttpExceptions expose `getStatus()`. This keeps 4xx domain failures (e.g.
 * a 401 bad login thrown by the shared AuthService) out of the 5xx alert stream.
 */
function resolveErrorStatus(err: unknown, res: FastifyReply): number {
  if (err instanceof SharedDomainException) return err.httpStatus;
  const getStatus = (err as { getStatus?: () => number }).getStatus;
  if (typeof getStatus === 'function') return getStatus.call(err);
  return res.statusCode || 500;
}

/**
 * Field names that must never appear in log output (e.g. Splunk, Datadog).
 * Compared case-insensitively against request body keys.
 */
const REDACTED_BODY_FIELDS = new Set([
  'password',
  'token',
  'secret',
  'authorization',
  'cookie',
  'access_token',
  'refresh_token',
  'api_key',
  'apikey',
  'x-api-key',
]);

function redactBody(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    out[k] = REDACTED_BODY_FIELDS.has(k.toLowerCase()) ? '[REDACTED]' : v;
  }
  return out;
}

/**
 * Emits ONE structured access-log line per request.
 *
 * Severity mirrors HTTP status:
 *   - 5xx → ERROR (alerts / PagerDuty)
 *   - 4xx → WARN  (client errors worth monitoring)
 *   - 2xx/3xx → LOG
 *
 * Includes:
 *   - `ip`     — client IP (honouring X-Real-IP / X-Forwarded-For proxy headers)
 *   - `userId` — from ALS after JWT validation (undefined on unauthenticated routes)
 *   - `body`   — redacted request body on 4xx/5xx only (useful for debugging)
 */
@Injectable()
export class HttpLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  constructor(private readonly ctx: RequestContextService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const res = context.switchToHttp().getResponse<FastifyReply>();

    if (SILENT_PREFIXES.some((p) => req.url.startsWith(p))) return next.handle();

    const start = Date.now();
    const ip =
      (req.headers['x-real-ip'] as string) ??
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ??
      req.ip ??
      'unknown';

    // Interval attribution. `start` is Nest pipeline entry, so `durationMs` has never
    // included anything before it. `albWaitMs` is the ALB-to-app gap decoded from
    // X-Amzn-Trace-Id (omitted inside its noise floor); `bodyWaitMs` is request-body
    // receipt. Together they say which side of the wire a slow request was slow on.
    const arrival = arrivalAtMs(req);
    const traceHeader = req.headers['x-amzn-trace-id'];
    const albWait = albWaitMs(
      arrival,
      albReceivedAtMs(Array.isArray(traceHeader) ? traceHeader[0] : traceHeader),
    );
    const bodyWait = arrival !== undefined ? start - arrival : undefined;

    return next.handle().pipe(
      tap({
        next: () => this.emit(req, res.statusCode, start, ip, albWait, bodyWait),
        error: (err: unknown) =>
          this.emit(req, resolveErrorStatus(err, res), start, ip, albWait, bodyWait),
      }),
    );
  }

  private emit(
    req: FastifyRequest,
    statusCode: number,
    start: number,
    ip: string,
    albWaitMs?: number,
    bodyWaitMs?: number,
  ): void {
    const userId = this.ctx.getUserId();
    const base = {
      method: req.method,
      url: req.url,
      statusCode,
      durationMs: Date.now() - start,
      ip,
      // Spread-omitted rather than logged as undefined: absent means "nothing worth
      // saying", and a fabricated 0 would read as "no delay" — the exact
      // misattribution these fields exist to prevent.
      ...(albWaitMs !== undefined ? { albWaitMs } : {}),
      ...(bodyWaitMs !== undefined ? { bodyWaitMs } : {}),
      ...(userId ? { userId } : {}),
    };

    if (statusCode >= 500) {
      this.logger.error({ ...base, body: redactBody(req.body) });
    } else if (statusCode >= 400) {
      this.logger.warn({ ...base, body: redactBody(req.body) });
    } else {
      this.logger.log(base);
    }
  }
}
