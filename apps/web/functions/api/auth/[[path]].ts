/**
 * Cloudflare Pages Function: proxy `/api/auth/*` on the SPA origin to the API origin.
 *
 * This is identity 8's own surface (Better Auth): `sign-in/social`, the Microsoft callback
 * `/api/auth/callback/microsoft` (the redirect URI registered on the Entra app), and `sign-out`. It must be
 * same-origin with the SPA for the same reason `/v1/*` is: the session cookie is set on the response the
 * browser lands on after Entra, and that response has to come from the SPA host.
 *
 * Placed under `functions/api/auth/` (path-scoped), like `functions/v1/`, so static asset serving stays on
 * Cloudflare's fast path. Shares `proxyToApi` with it: same header hygiene, same `X-Forwarded-*` from the
 * trusted edge, same cookie passthrough.
 *
 * Requires the Pages project to expose an `API_ORIGIN` environment variable,
 * e.g. `https://opshub-api-dev.qnsc.vn`.
 */
import { proxyToApi } from '../../_lib/proxy';

interface Env {
  API_ORIGIN?: string;
}

type PagesFunction = (context: { request: Request; env: Env }) => Promise<Response>;

export const onRequest: PagesFunction = (context) =>
  proxyToApi(context.request, context.env.API_ORIGIN);
