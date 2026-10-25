/**
 * The API's OpenTelemetry options. The bootstrap itself (OpenTelemetry first, then the module, the pino logger, shutdown) is
 * `createHttpApp` in `@quynhonsemiconductor/platform-runtime/bootstrap`; this file holds only what is opshub's own. It imports nothing,
 * so loading it from main.ts cannot pull pg/http/ioredis in ahead of the instrumentation.
 */

/**
 * Inbound-HTTP latency histogram boundaries, in milliseconds.
 *
 * WHY OPSHUB SETS THESE AT ALL. Omitting the option keeps the OpenTelemetry JS default
 * boundaries, whose largest finite value is 10000. Everything slower lands in one overflow
 * bucket, and `histogram_quantile` cannot interpolate past the largest finite boundary — so
 * a p99 alert reporting "10 seconds" is not reporting a latency at all, it is reporting
 * "somewhere above 10 seconds", and a 12 s request is arithmetically indistinguishable from
 * a 41 s one. That is exactly how the sibling product's alert was read as a 10 s p99 when
 * the true figure was unbounded above.
 *
 * ONLY THIS APP. `apps/worker/src/otel.ts` deliberately does not pass them: the worker
 * boots with `NestFactory.createApplicationContext`, so it runs no HTTP server and never
 * records `http.server.duration` — a view there would select an instrument that is never
 * created. `apps/web` is a Vite SPA with no Node server of its own and no OTel bootstrap.
 * The api is the only process in this repo with inbound HTTP.
 *
 * KNOWN RESIDUAL, recorded so it is not mistaken for a bug in these numbers. The SSE route
 * `GET /v1/notifications/stream` (`libs/modules/notifications/.../notification-sse.controller.ts`)
 * holds its response open for the life of the browser tab, and its `http.server.duration`
 * observation is a connection lifetime rather than a latency. It lands in the 180000 rung or
 * the overflow. The observation is separable by its route attribute, which is the correct
 * place to exclude it. Note that opshub's `HttpLoggingInterceptor` records no metrics at all,
 * so unlike the sibling product there is no application-side histogram for this route to
 * distort — only this one, from `@opentelemetry/instrumentation-http`.
 *
 * COST, AND THE 2026-10-21 TRIM. Every boundary is one `_bucket` series per label
 * combination x instance on this instrument, and at ~1 DPM per active series past Grafana
 * Cloud's included rate those series are the bill. The set is trimmed from 19 to 8 finite
 * rungs (mirrored in `infra/modules/stack`'s `http_duration_buckets_ms`):
 *
 *   250      — the one remaining low-end rung. The 5-100 ms fine grain is gone; a 40-to-90 ms
 *              regression is no longer separately visible, which is the accepted price.
 *   1000     — production's `slow_request_bucket_ms` (the `http-slow-request-count` rule and
 *              the precondition select on it; it must remain an exported boundary).
 *   2500     — develop's `slow_request_bucket_ms`.
 *   5000     — one `database`-preset attempt.
 *   10000    — the old default clamp, kept so a p99 "at least 10 s" reads the same as before.
 *   60000    — the AWS ALB default idle timeout.
 *   180000   — above `external`'s exhaustion (~41 s) and the SSE connection lifetimes, so a
 *              genuinely stuck request lands in a finite rung rather than the overflow.
 */
export const HTTP_DURATION_BOUNDARIES_MS = [0, 250, 1000, 2500, 5000, 10000, 60000, 180000];
