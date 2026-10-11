import { SESSION_COOKIE } from '../auth/session-cookie';

/** Header the SPA echoes the CSRF token in. Must also be in the CORS allow-list. */
export const CSRF_HEADER = 'x-csrf-token';

/**
 * Cookie holding the CSRF *secret* (not the token). `__Host-` pins it to Secure +
 * Path=/ + no Domain, and it is signed, so a subdomain or a non-TLS origin cannot
 * plant one.
 */
export const CSRF_SECRET_COOKIE = '__Host-opshub_csrf';

/** Methods that cannot change state, so cannot be the target of a CSRF attack. */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);

/**
 * Routes that must stay reachable without a CSRF token. Each is a deliberate
 * exemption with a reason, not an oversight:
 *
 *  - `/api/auth/` is identity 8's own surface (sign-in, sign-out). It is mounted outside `/v1` and runs
 *    BEFORE any session exists for a sign-in, so there is no token to issue; Better Auth enforces its own
 *    Origin check on every state-changing request there (`disableOriginCheck: false`, explicit), with
 *    `trustedOrigins` the SPA origin only.
 *
 * Nothing else is exempt. (A `/v1/webhooks/inbound` entry used to be here for a receiver that was never
 * built; no such route exists, and an exemption for a path that does not exist is a hole waiting for someone
 * to add one. A route that really is called by a service carries no session cookie, so this gate already
 * does not apply to it.)
 */
const EXEMPT_PATHS: readonly string[] = ['/api/auth'];

/** True when `url`'s path (query stripped) is an exempt route. */
function isExemptPath(url: string): boolean {
  const path = url.split('?')[0];
  return EXEMPT_PATHS.some((exempt) => path === exempt || path.startsWith(`${exempt}/`));
}

/**
 * Whether this request must present a valid CSRF token.
 *
 * CSRF is only possible when the browser attaches a credential AMBIENTLY — here, the
 * identity session cookie (`SESSION_COOKIE`). So the check applies exactly when all of these
 * hold:
 *
 *  1. the method can change state;
 *  2. a session cookie is actually present — with no ambient credential there is
 *     nothing to forge (there is no Bearer credential any more: the session cookie is the only way in);
 *  3. the route is not a deliberate exemption.
 *
 * Kept a pure function of the request so the policy lives in ONE place and is
 * unit-testable. Spread across route decorators, an omission is invisible; here, a
 * new controller is covered by default.
 */
export function requiresCsrfProtection(req: {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  cookies?: Record<string, string | undefined>;
}): boolean {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return false;
  if (!req.cookies?.[SESSION_COOKIE]) return false;
  return !isExemptPath(req.url);
}
