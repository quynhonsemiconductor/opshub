import type { JwtPayload } from './jwt.strategy';

/**
 * Optional bridge that lets the shared {@link JwtAuthGuard} authenticate a request
 * from an opaque, server-side BFF session cookie when no `Bearer` token is present.
 *
 * The concrete implementation (Entra OIDC + Valkey session, both from
 * `@quynhonsemiconductor/identity`) lives in the product's identity module and is bound to
 * {@link BFF_SESSION_RESOLVER}. While it is UNBOUND the guard behaves exactly as a
 * pure JWT guard, so the Bearer path is untouched — which is what lets the BFF land
 * in the codebase before the shared cache exists to hold its sessions.
 *
 * The inversion also keeps the platform layer free of a dependency on the identity
 * module: the guard knows a contract, not an implementation.
 */
export interface BffSessionResolver {
  /** Whether BFF session auth is active. When false the guard skips the cookie path. */
  readonly enabled: boolean;
  /**
   * Resolve — and transparently refresh near expiry — the request principal for a
   * session id, or `null` when the session is missing or invalid.
   */
  resolve(sid: string, ip: string): Promise<JwtPayload | null>;
}

/**
 * Name of the cookie carrying the opaque BFF session id. Declared here so the guard
 * that READS it and the controller that ISSUES it cannot disagree.
 *
 * `__Host-` pins it to Secure + Path=/ + no Domain, so a subdomain or a plain-HTTP
 * origin cannot plant one. It holds a session id and nothing else: no claims, no
 * token, nothing the browser or an XSS payload can read or replay elsewhere.
 */
export const BFF_SESSION_COOKIE = '__Host-opshub_session';

/** DI token for the optional {@link BffSessionResolver}. */
export const BFF_SESSION_RESOLVER = Symbol('BFF_SESSION_RESOLVER');
