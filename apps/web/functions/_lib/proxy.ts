/**
 * Same-origin reverse proxy used by the Cloudflare Pages Functions that front the opshub SPA. It forwards
 * `/v1/*` and identity 8's `/api/auth/*` (sign-in, the Microsoft callback, sign-out) from the SPA origin
 * (`opshub-dev.qnsc.vn`) to the API origin (`opshub-api-dev.qnsc.vn`), so the browser sees a single origin.
 * That is what lets the API set its `__Host-` (production) / `__Secure-` opshub.session_token cookie on the host the SPA uses and drop
 * CORS entirely.
 *
 * The forwarding itself is `@quynhonsemiconductor/platform-http/edge`'s `forwardToOrigin`, shared by every
 * product, and this file is only opshub's configuration of it. What it does that a hand-written proxy gets wrong:
 *
 *  - it does NOT follow redirects, so identity's `/api/auth/callback/*` 302 and its `Set-Cookie` reach the
 *    browser instead of being followed inside the Function;
 *  - it forwards an ALLOW-LIST of headers (never `x-forwarded-for`, `x-real-ip`, `cf-*` or a visitor's own
 *    `x-qnsc-edge-*`), so what the API sees as the client is not a header a visitor chose;
 *  - it SIGNS the visitor's address (`cf-connecting-ip`) with `EDGE_CLIENT_IP_SECRET`, covering the address, a
 *    timestamp, the method and the path. Behind a Pages Function the API's own `cf-connecting-ip` is a Cloudflare
 *    address shared by every visitor: without the signature one per-address pre-auth bucket
 *    would be shared by the whole company. The API verifies it in `clientIp()`.
 *
 * Requires the Pages project to expose two variables: `API_ORIGIN` (e.g. `https://opshub-api-dev.qnsc.vn`) and
 * `EDGE_CLIENT_IP_SECRET` (a Pages SECRET: the same value as the API's, at least 32 characters). A Function
 * missing either answers 500 naming it: a proxy that quietly forwards unsigned puts every visitor in one bucket.
 */
import { EDGE_SECRET_MIN_LENGTH, forwardToOrigin } from '@quynhonsemiconductor/platform-http/edge';

export interface ProxyEnv {
  API_ORIGIN?: string;
  EDGE_CLIENT_IP_SECRET?: string;
}

/**
 * Request headers the SPA sends that the shared allow-list does not name: the CSRF token (without it every
 * write is a 403), the SSE reconnect position and its cache hint, and W3C baggage.
 */
export const SPA_FORWARD_HEADERS: readonly string[] = [
  'x-csrf-token',
  'last-event-id',
  'cache-control',
  'baggage',
];

/** The API URL for this request: the API origin, with the incoming path and query as they are. */
export function buildTarget(requestUrl: string, apiOrigin: string): URL {
  const incoming = new URL(requestUrl);
  const target = new URL(apiOrigin);
  target.pathname = incoming.pathname;
  target.search = incoming.search;
  return target;
}

/**
 * Proxy a request to the API origin. `fetcher` is injectable for testing; production uses the platform `fetch`.
 */
export async function proxyToApi(
  request: Request,
  env: ProxyEnv,
  fetcher: (request: Request) => Promise<Response> = (r) => fetch(r),
): Promise<Response> {
  if (!env.API_ORIGIN) {
    return new Response('Proxy misconfigured: API_ORIGIN is not set', { status: 500 });
  }
  const secret = env.EDGE_CLIENT_IP_SECRET?.trim() ?? '';
  if (secret.length < EDGE_SECRET_MIN_LENGTH) {
    return new Response(
      `Proxy misconfigured: EDGE_CLIENT_IP_SECRET is not set (at least ${EDGE_SECRET_MIN_LENGTH} characters)`,
      { status: 500 },
    );
  }
  return forwardToOrigin(
    request,
    {
      secret,
      target: buildTarget(request.url, env.API_ORIGIN),
      forwardHeaders: SPA_FORWARD_HEADERS,
    },
    fetcher,
  );
}
