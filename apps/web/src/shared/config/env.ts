/**
 * Centralised environment configuration.
 * All `import.meta.env.*` access for the API origin should go through here.
 */
export const ENV = {
  // Empty string → relative URLs, and that is the intended value in EVERY environment.
  // Locally the Vite proxy handles /v1 and /api/auth; deployed, the SPA is served from
  // Cloudflare Pages and Pages Functions (apps/web/functions/v1/[[path]].ts and
  // functions/api/auth/[[path]].ts) forward them to the API origin, so the browser only
  // ever sees one origin.
  //
  // Do NOT point VITE_API_URL at the API host. Same-origin is a requirement, not a
  // preference: identity 8 sets its `__Host-` (production) / `__Secure-` session cookie on the response the
  // browser lands on after Entra, on the SPA host; talking to the API directly would
  // put the cookie on another site and break login while appearing to work for
  // unauthenticated requests.
  API_BASE_URL: import.meta.env.VITE_API_URL ?? '',
} as const;
