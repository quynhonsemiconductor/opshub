/**
 * Auth bootstrap — runs once on app start, and again on every page refresh.
 *
 * Restores the session from the same-origin opshub.session_token cookie (`__Host-` in production) by calling the
 * cookie-authenticated `GET /v1/auth/me`. There are no in-browser tokens: the shared
 * guard resolves the session server-side and refreshes the underlying access token
 * itself. Must be awaited before the router guard reads `isAuthenticated()`.
 */
import { ENV } from '@/shared/config/env';
import { ME_QUERY_KEY } from '@/shared/hooks/use-current-user';
import { queryClient } from './query-client';
import { setCsrfToken } from './csrf';
import { useAuthStore, type SessionUser } from './auth-store';
import { RATE_LIMIT_MAX_RETRIES, rateLimitDelayMs, sleep } from './rate-limit-retry';

let _bootstrapPromise: Promise<void> | null = null;

/** Shown when the session could not be resolved, but the caller may still be signed in. */
const UNAVAILABLE =
  'OpsHub could not verify your session. This is usually temporary — try again in a moment.';

/** Shown when no response arrived at all. Distinct from a 5xx, so the advice is different. */
const UNREACHABLE = 'OpsHub could not be reached. Check your connection and try again.';

/** Temporary failures are retried; every other non-ok answer is reported, never treated as a logout. */
function isTransient(status: number): boolean {
  return status === 429 || status >= 500;
}

function unavailableMessage(status: number): string {
  return status === 429 ? 'OpsHub is busy right now. Wait a moment and try again.' : UNAVAILABLE;
}

/** Idempotent: React StrictMode's double-invoke shares one in-flight promise. */
export function bootstrapAuth(): Promise<void> {
  if (_bootstrapPromise) return _bootstrapPromise;
  _bootstrapPromise = _run();
  return _bootstrapPromise;
}

/**
 * Call after logout so the next navigation bootstraps again.
 *
 * ALSO EMPTIES THE QUERY CACHE, because the cache holds one identity's data and the next caller may be
 * somebody else. Not currently reachable in production — signing in goes through
 * `window.location.assign(authorizeUrl)`, a full navigation that discards the cache with the page — so
 * this closes a hole that depends on that remaining true rather than one that is open today.
 *
 * `clear()` and not a targeted removal: the leak is not only `auth/me`. Every list the previous session
 * read is in there, including ones the next identity may hold no permission for.
 */
export function resetBootstrap(): void {
  _bootstrapPromise = null;
  queryClient.clear();
  useAuthStore.getState().setError(null);
}

async function _run(): Promise<void> {
  const { clear, setError, setReady, setUser } = useAuthStore.getState();
  try {
    /*
     * A 429 IS NOT A LOGOUT. This used to call `clear()` on any non-ok answer, so one busy minute on
     * the API sent a perfectly valid session to the login page — and every page load re-ran the
     * bootstrap, so the same busy minute logged them out again on the way back. The same was true of
     * a 502 from the proxy and of being offline.
     *
     * Only 401 and 403 mean "there is no session": the cookie is absent/expired (401) or the server
     * refuses this identity (403). Everything else is reported, and the router is not allowed to
     * assume the user is signed out.
     */
    let res: Response | null = null;
    for (let attempt = 0; ; attempt++) {
      try {
        // `credentials: 'include'` is what sends the session cookie. Same-origin in every
        // environment — locally via the Vite proxy, deployed via the Cloudflare Pages
        // Function — so this is not a cross-site request and needs no CORS.
        res = await fetch(`${ENV.API_BASE_URL}/v1/auth/me`, {
          credentials: 'include',
          referrerPolicy: 'no-referrer',
          headers: { accept: 'application/json' },
        });
      } catch {
        if (attempt < RATE_LIMIT_MAX_RETRIES) {
          await sleep(rateLimitDelayMs(attempt));
          continue;
        }
        setError(UNREACHABLE);
        return;
      }

      if (res.status === 401 || res.status === 403) {
        // The ordinary "not signed in yet" answer, and the only answers that mean so.
        clear();
        return;
      }

      if (res.ok) break;

      if (isTransient(res.status) && attempt < RATE_LIMIT_MAX_RETRIES) {
        // The API sends `Retry-After` on 429; on a 5xx it is usually absent, so back off.
        await sleep(rateLimitDelayMs(attempt, res));
        continue;
      }

      setError(unavailableMessage(res.status));
      return;
    }

    let user: SessionUser & { csrfToken?: string };
    try {
      user = (await res.json()) as SessionUser & { csrfToken?: string };
    } catch {
      setError(UNAVAILABLE);
      return;
    }
    /*
     * HANDED TO THE QUERY CACHE, not thrown away.
     *
     * This request has to happen — the router guard cannot decide anything until the session is known —
     * and `useCurrentUser` asked the API for the same document a moment later, because it had no way to
     * know this answer existed. Measured on a Playwright run: 54 `GET /v1/auth/me` across 28 page loads,
     * which is the duplicate, twice per boot.
     *
     * `setQueryData`, not `prefetchQuery`: the data is already in hand, so fetching it again to populate
     * a cache would be the bug this fixes.
     */
    queryClient.setQueryData(ME_QUERY_KEY, user);
    // Session-bound CSRF token for this page's lifetime. Every state-changing request
    // echoes it in X-CSRF-Token; the server holds the matching secret in an httpOnly
    // cookie. Only issued to a request that carries the session cookie, so it is absent
    // otherwise and `withCsrfHeader` then simply adds nothing.
    setCsrfToken(user.csrfToken ?? null);
    setUser({
      sub: user.sub,
      email: user.email,
      name: user.name,
      roles: user.roles,
      permissions: user.permissions,
    });
  } finally {
    setReady(true);
  }
}
