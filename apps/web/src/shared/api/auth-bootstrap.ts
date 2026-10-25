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

let _bootstrapPromise: Promise<void> | null = null;

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
}

async function _run(): Promise<void> {
  const { clear, setReady, setUser } = useAuthStore.getState();
  try {
    // `credentials: 'include'` is what sends the session cookie. Same-origin in every
    // environment — locally via the Vite proxy, deployed via the Cloudflare Pages
    // Function — so this is not a cross-site request and needs no CORS.
    const res = await fetch(`${ENV.API_BASE_URL}/v1/auth/me`, {
      credentials: 'include',
      referrerPolicy: 'no-referrer',
      headers: { accept: 'application/json' },
    });

    if (!res.ok) {
      // 401 is the ordinary "not signed in yet" answer, not an error worth surfacing.
      clear();
      return;
    }

    const user = (await res.json()) as SessionUser & { csrfToken?: string };
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
  } catch {
    // Network failure — treated as unauthenticated so the router can show the login
    // page rather than a blank shell.
    clear();
  } finally {
    setReady(true);
  }
}
