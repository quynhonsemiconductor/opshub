import createClient, { type Middleware } from 'openapi-fetch';
import type { paths } from './generated/api';
import { useAuthStore } from './auth-store';
import { withCsrfHeader } from './csrf';
import { ENV } from '@/shared/config/env';

/**
 * Cookie-authenticated middleware (identity 8 session cookie).
 *
 * Every request carries the opaque `__Secure-opshub.session_token` cookie, and every
 * state-changing one echoes the session-bound CSRF token. No Authorization header, no
 * token in the JS heap.
 *
 * What this replaced, and why none of it is needed any more: a Bearer header from an
 * in-memory access token, a 401 handler that silently refreshed and retried, single-flight
 * de-duplication of that refresh, and a cross-tab Web Locks mutex so two tabs could not
 * replay the same single-use refresh cookie — which the server treats as token theft and
 * answers by revoking the entire family. The server now refreshes the token behind the
 * session, so there is nothing for the browser to coordinate and no race left to lose.
 */
const sessionMiddleware: Middleware = {
  onRequest({ request }) {
    for (const [name, value] of Object.entries(withCsrfHeader(request.method))) {
      request.headers.set(name, value);
    }
    return request;
  },

  onResponse({ response }) {
    // A 401 now means the session is gone server-side — expired, revoked, or logged out
    // in another tab. There is no local credential to renew, so the only correct move is
    // to send the user back to the login page.
    if (response.status === 401) {
      useAuthStore.getState().clear();
      // Guard against a redirect loop: /login itself renders unauthenticated.
      if (!window.location.pathname.startsWith('/login')) {
        window.location.replace('/login');
      }
    }
    return response;
  },
};

/**
 * Typed API client.
 *
 * `credentials: 'include'` is set once, here, so no call site can forget it — a request
 * without it silently drops the session cookie and 401s, which reads like an expired
 * login rather than a missing option.
 *
 * `API_BASE_URL` is empty in every environment: locally the Vite proxy forwards `/v1`,
 * and deployed the Cloudflare Pages Function forwards it to the API origin. Same-origin
 * is a requirement of the session cookie, not a convenience.
 */
export const api = createClient<paths>({
  baseUrl: ENV.API_BASE_URL,
  credentials: 'include',
});
api.use(sessionMiddleware);
