import { NonRetryableError, RetryAfterError } from '@platform';

interface GraphErrorLike {
  statusCode?: number;
  message?: string;
  headers?: { get(name: string): string | null } | Record<string, string> | undefined;
}

function retryAfterMs(headers: GraphErrorLike['headers']): number | undefined {
  if (!headers) return undefined;
  const raw =
    typeof (headers as { get?: unknown }).get === 'function'
      ? (headers as { get(n: string): string | null }).get('retry-after')
      : ((headers as Record<string, string>)['retry-after'] ??
        (headers as Record<string, string>)['Retry-After']);
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds) * 1000;
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/**
 * What an outbox relay should do with a Graph failure.
 *
 *   400, 403, 404  -> {@link NonRetryableError}: a malformed request, a missing permission or a deleted
 *                     user will not heal in 30 seconds. Dead-letter now, so the alarm fires on the first
 *                     attempt instead of the fifth.
 *   429, 503, 504  -> {@link RetryAfterError} when the server says how long (the `Retry-After` header).
 *   anything else  -> unchanged: the relay's ordinary backoff.
 */
export function classifyGraphError(err: unknown): unknown {
  const e = err as GraphErrorLike;
  const status = e?.statusCode;
  if (status === 400 || status === 403 || status === 404) {
    return new NonRetryableError(`Graph ${status}: ${e.message ?? 'request refused'}`);
  }
  if (status === 429 || status === 503 || status === 504) {
    const wait = retryAfterMs(e.headers);
    if (wait !== undefined) {
      return new RetryAfterError(`Graph ${status}: ${e.message ?? 'throttled'}`, wait);
    }
  }
  return err;
}
