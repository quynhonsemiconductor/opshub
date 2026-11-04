/**
 * Every outbound request carries a deadline.
 *
 * A connection that opens and then stalls never rejects: `fetch` waits forever. The auth bootstrap's
 * `catch` only sees rejected fetches, so without a deadline a hung proxy or a dead mobile link left the
 * shell on the loading screen — no error, no retry screen, `ready` never set. The same stall inside the
 * client's 429 loop would leave every query pending, and the retries would multiply it.
 *
 * `AbortSignal.timeout` turns that silence into an `AbortError`, which the callers already handle as a
 * network failure: the bootstrap reports `UNREACHABLE` after its retries, the query client surfaces the
 * error to TanStack. A fresh signal goes on each attempt, so one attempt's deadline cannot cancel its
 * retry.
 *
 * Fifteen seconds is long enough for a slow mobile connection to finish `GET /v1/auth/me` and short
 * enough that a dead one fails while the person is still looking at the screen.
 */
export const REQUEST_TIMEOUT_MS = 15_000;
