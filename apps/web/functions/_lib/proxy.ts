/**
 * Same-origin reverse proxy used by the Cloudflare Pages Function that fronts
 * the opshub SPA. It forwards `/v1/*` and identity 8's `/api/auth/*` (sign-in, the
 * Microsoft callback, sign-out) from the SPA origin (`opshub-dev.qnsc.vn`) to the API
 * origin (`opshub-api-dev.qnsc.vn`), so the browser sees a single origin. That is what
 * lets the API set its `__Secure-opshub.session_token` cookie on the host the SPA uses
 * and drop CORS entirely.
 *
 * The logic here is pure and framework-agnostic (only web-standard `Request` /
 * `Response` / `Headers` / `URL`), so it is unit-testable under the web app's
 * vitest and portable to a standalone Worker if we ever move off Pages.
 *
 * Requires the Pages project to expose `API_ORIGIN`, e.g.
 * `https://opshub-api-dev.qnsc.vn`. The SPA always talks to the API through this
 * same-origin proxy (the session cookie depends on it).
 */

/** Hop-by-hop headers that must never cross a proxy boundary (RFC 7230 §6.1). */
const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Methods that never carry a request body. */
const BODILESS_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/**
 * Client-supplied forwarding/trust headers that must be stripped before we set
 * our own from the trusted Cloudflare edge. Forwarding an inbound value would
 * let a caller spoof their apparent IP for the API's rate-limit/audit/geo logic.
 */
const CLIENT_SPOOFABLE_HEADERS: ReadonlySet<string> = new Set([
  'x-forwarded-for',
  'x-real-ip',
  'forwarded',
]);

/** Rebuild the target URL: keep the incoming path + query, swap in the API origin. */
export function buildUpstreamUrl(requestUrl: string, apiOrigin: string): string {
  const incoming = new URL(requestUrl);
  const upstream = new URL(apiOrigin);
  upstream.pathname = incoming.pathname;
  upstream.search = incoming.search;
  return upstream.toString();
}

/**
 * Build the request forwarded to the API origin: same method/body, headers with
 * hop-by-hop + `host` stripped, and `X-Forwarded-*` set from the Cloudflare edge
 * so the API's cookie logic (which reads `x-forwarded-proto` and the client IP)
 * behaves as if the request arrived directly.
 */
export function buildProxyRequest(request: Request, apiOrigin: string): Request {
  const url = buildUpstreamUrl(request.url, apiOrigin);
  const headers = new Headers(request.headers);
  for (const header of HOP_BY_HOP_HEADERS) headers.delete(header);
  headers.delete('host');

  // Drop any client-supplied forwarding/trust headers before setting our own.
  // The Worker sits directly behind Cloudflare, so `cf-connecting-ip` is the
  // single authoritative client IP; preserving an inbound X-Forwarded-For would
  // let a caller spoof their apparent IP for the API's rate-limit/audit/geo
  // decisions (the API trusts these headers via Fastify `trustProxy`).
  for (const header of CLIENT_SPOOFABLE_HEADERS) headers.delete(header);

  const clientIp = request.headers.get('cf-connecting-ip');
  if (clientIp) headers.set('x-forwarded-for', clientIp);
  headers.set('x-forwarded-proto', 'https');
  headers.set('x-forwarded-host', new URL(request.url).host);

  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers,
    redirect: 'manual',
  };
  if (!BODILESS_METHODS.has(request.method.toUpperCase())) {
    init.body = request.body;
    init.duplex = 'half'; // required when streaming a body (undici/Workers)
  }
  return new Request(url, init);
}

/**
 * Copy the upstream response back to the client, preserving status and every
 * `Set-Cookie` header individually (a naive `new Headers(res.headers)` collapses
 * multiple cookies into one comma-joined value and corrupts them).
 *
 * NOTE for anyone tempted to simplify this back to `new Headers(upstream.headers)`: the
 * unit suite will NOT stay green if you do — see the stub-based test in proxy.spec.ts,
 * which exists because every other assertion there passes against the naive version
 * (undici carries the set-cookie list through the constructor). The Workers runtime this
 * actually runs on historically does not, and a corrupted session cookie is a
 * silent login failure.
 */
export function buildClientResponse(upstream: Response): Response {
  const headers = new Headers();

  // Collected during the same pass, and used ONLY if `getSetCookie` turns out to be
  // unavailable. Pairing the skip below with `?? []` meant a runtime without
  // `getSetCookie` skipped every Set-Cookie header and then appended nothing — the
  // cookies vanished. That is the worst shape this bug can take: the API returns 200, the
  // proxy returns 200, and the browser simply never receives the session cookie, so a
  // successful login presents as an immediate silent logout. (rally#259.)
  const fallbackSetCookie: string[] = [];

  upstream.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') {
      fallbackSetCookie.push(value);
      return;
    }
    headers.set(key, value);
  });

  const setCookies = upstream.headers.getSetCookie?.() ?? fallbackSetCookie;
  for (const cookie of setCookies) headers.append('set-cookie', cookie);

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

/**
 * Proxy a request to the API origin. `fetchImpl` is injectable for testing;
 * production passes the platform `fetch`.
 */
export async function proxyToApi(
  request: Request,
  apiOrigin: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  if (!apiOrigin) {
    return new Response('Proxy misconfigured: API_ORIGIN is not set', { status: 500 });
  }
  const upstream = await fetchImpl(buildProxyRequest(request, apiOrigin));
  return buildClientResponse(upstream);
}
