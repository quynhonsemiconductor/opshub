/**
 * Shared 429 policy for the SPA.
 *
 * A rate-limited response is temporary and its `Retry-After` says how long to wait. Treating it as a
 * failed request — in particular, treating it as "not signed in" — turns a busy minute into a logout.
 * Both the auth bootstrap and the generated API client retry through here so they honour the same
 * header and the same ceiling.
 *
 * The cap matters as much as the header: a proxy is free to send `Retry-After: 3600`, and waiting an
 * hour before the shell renders is indistinguishable from being broken. Ten seconds is the longest a
 * person will wait at a loading screen; after that the caller is told to retry.
 */

/** How many times a rate-limited request is retried before the caller sees the 429. */
export const RATE_LIMIT_MAX_RETRIES = 2;

/** The longest single wait, however large a `Retry-After` the server sends. */
export const RATE_LIMIT_MAX_DELAY_MS = 10_000;

/** First wait when the response carries no usable `Retry-After`. */
const BASE_DELAY_MS = 500;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `Retry-After` in milliseconds: delta-seconds (the form the API sends) or an HTTP-date.
 * `null` when the header is absent or unparseable, so the caller can fall back to backoff.
 */
export function retryAfterMs(header: string | null | undefined): number | null {
  if (!header) return null;

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);

  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

/** The wait before retry `attempt` (0-based), honouring `Retry-After` and capping either form. */
export function rateLimitDelayMs(attempt: number, response?: Response | null): number {
  const hinted = retryAfterMs(response?.headers.get('retry-after'));
  return Math.min(hinted ?? BASE_DELAY_MS * 2 ** attempt, RATE_LIMIT_MAX_DELAY_MS);
}

/**
 * The same wait for an error that carries the rate limit as data.
 *
 * The generated client retries 429s itself (see `client.ts`), so this exists for a thrown error that
 * already knows its status and header — a hand-written `sessionFetch` query, or a future client that
 * rejects instead of returning `{ error }`.
 */
export function retryDelayFromError(attempt: number, error: unknown): number {
  const candidate = error as { retryAfterMs?: unknown; retryAfter?: unknown } | null | undefined;
  const hinted =
    typeof candidate?.retryAfterMs === 'number'
      ? candidate.retryAfterMs
      : typeof candidate?.retryAfter === 'number'
        ? candidate.retryAfter * 1000
        : null;

  return Math.min(hinted ?? BASE_DELAY_MS * 2 ** attempt, RATE_LIMIT_MAX_DELAY_MS);
}
