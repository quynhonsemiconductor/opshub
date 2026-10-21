/**
 * The product name identity 8 is built with (`createIdentity({ product })`): the cookie prefix, the 2FA issuer
 * and the app name. One constant, so the cookie name below cannot drift from the factory call.
 */
export const IDENTITY_PRODUCT = 'opshub';

/**
 * Whether identity names its cookies `__Host-<product>.*` (`hostCookies`) instead of `__Secure-<product>.*`: in production, yes.
 * A browser stores a `__Host-` cookie only if it is `Secure`, has `Path=/` and has NO `Domain`, so a sibling `*.qnsc.vn` app cannot
 * set one for this host. Outside production the names stay `__Secure-`, which is what the unit and e2e suites, local development over
 * http://localhost and the Pages dev server use.
 *
 * Read once, at import, from the same `NODE_ENV` the env schema validates; the identity factory takes THIS value, so the name that is
 * issued and the name the CSRF gate and the SPA bootstrap look for cannot disagree.
 */
export const HOST_COOKIES: boolean = process.env['NODE_ENV'] === 'production';

/**
 * Name of the identity 8 session cookie: `__Host-<product>.session_token` in production, `__Secure-<product>.session_token` elsewhere
 * (Better Auth, `useSecureCookies`; host-only, `HttpOnly`, `SameSite=Lax`). Declared here so the CSRF gate that READS it cannot
 * disagree with the mount that ISSUES it.
 *
 * It replaces v7's `__Host-opshub_session`. It holds a signed opaque token and nothing else.
 */
export const SESSION_COOKIE = `${HOST_COOKIES ? '__Host-' : '__Secure-'}${IDENTITY_PRODUCT}.session_token`;
