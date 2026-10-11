/**
 * The product name identity 8 is built with (`createIdentity({ product })`): the cookie prefix, the 2FA issuer
 * and the app name. One constant, so the cookie name below cannot drift from the factory call.
 */
export const IDENTITY_PRODUCT = 'opshub';

/**
 * Name of the identity 8 session cookie: `__Secure-<product>.session_token` (Better Auth, with
 * `useSecureCookies`; host-only, `HttpOnly`, `SameSite=Lax`). Declared here so the CSRF gate and the rate
 * limiter that READ it cannot disagree with the mount that ISSUES it.
 *
 * It replaces v7's `__Host-opshub_session` (`SameSite=Strict`). It holds a signed opaque token and nothing else.
 */
export const SESSION_COOKIE = `__Secure-${IDENTITY_PRODUCT}.session_token`;
