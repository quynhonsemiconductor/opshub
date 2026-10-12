/**
 * Cloudflare Pages Function: proxy `/v1/*` on the SPA origin to the API origin.
 *
 * Placed under `functions/v1/` (path-scoped) rather than a global
 * `_middleware.ts` so that static asset serving stays on Cloudflare's fast path
 * and is never routed through user code.
 *
 * Requires the Pages project to expose `API_ORIGIN` (e.g. `https://opshub-api-dev.qnsc.vn`) and the secret
 * `EDGE_CLIENT_IP_SECRET`; see `../_lib/proxy.ts`.
 */
import { proxyToApi, type ProxyEnv } from '../_lib/proxy';

type PagesFunction = (context: { request: Request; env: ProxyEnv }) => Promise<Response>;

export const onRequest: PagesFunction = (context) => proxyToApi(context.request, context.env);
