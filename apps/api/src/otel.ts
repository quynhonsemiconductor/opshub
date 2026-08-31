/**
 * OpenTelemetry bootstrap for the API — must be the very first import in main.ts, so
 * auto-instrumentation patches HTTP, pg, ioredis and the AWS SDK before any module loads
 * them.
 *
 * The implementation is shared, in `@qnsc-vn/observability`. Imported from its `/otel`
 * subpath rather than the package root on purpose: the root barrel reaches Nest and pino,
 * which would then be required BEFORE instrumentation is installed — defeating the reason
 * this import sits at the top of main.ts.
 *
 * This replaced a local copy in libs/platform. That copy had drifted behind the package in
 * ways nobody could see from reading it: no sampler (so `OTEL_SAMPLING_PROBABILITY` was
 * configured and ignored until #110 added one here), no `service.namespace` or
 * `service.instance.id`, no deployment-environment attribute, and no batch tuning. Sharing
 * one implementation is what stops that happening again — and it is why the sampler spec
 * that lived beside the local copy is gone: the behaviour it pinned is the package's now,
 * and duplicating the assertion here would only pin our copy of someone else's decision.
 *
 * Shutdown: call `shutdownOtel()` from the main.ts signal handler BEFORE `app.close()`, so
 * in-flight spans are exported rather than dropped. Do NOT register a second SIGTERM
 * handler here — main.ts owns the shutdown sequence.
 */
import { shutdownOtel, startOtel } from '@qnsc-vn/observability/otel';

export { shutdownOtel };

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
 * THE LOW END IS THE OTEL DEFAULT SET, UNCHANGED — 0 through 10000. That is not laziness,
 * it is the point: opshub's healthy p99 is well under 100 ms, and the fine-grained rungs at
 * 5/10/25/50/75/100 are what make a regression from 40 ms to 90 ms visible. A tempting
 * alternative was to rebuild the whole scale logarithmically, which would have read more
 * elegantly and lost resolution precisely where the product normally lives. Keeping the
 * default prefix also means every existing bucket boundary still exists, so a dashboard or
 * recording rule built on the old set continues to resolve — the change is purely additive.
 *
 * THE ADDED RUNGS ARE THE TIMEOUT BUDGETS THAT ACTUALLY EXIST ON THIS REQUEST PATH, not
 * round numbers. Read against `libs/platform/src/resilience/resilience.service.ts`, where
 * cockatiel's `maxAttempts` counts RETRIES, so total calls are `maxAttempts + 1`:
 *
 *   15000 — the `database` preset's full budget: 3 calls x 5s + 100 + 200ms backoff ≈ 15.3s.
 *           Also separates "one 10 s attempt then success" from a genuinely stuck request.
 *   30000 — a floor under the `external` preset's exhaustion, so a request that burned most
 *           of that budget is distinguishable from one that burned all of it.
 *   45000 — above `external`'s true worst case: 4 calls x 10s + 200 + 400 + 800ms ≈ 41.4s.
 *           This is the rung that makes the widening worth doing — an `external`-bounded
 *           request now lands in a finite bucket instead of the overflow, so a p99 computed
 *           over it is a number rather than a clamp.
 *   60000 — the AWS ALB default idle timeout (not overridden anywhere in `infra/`). Past
 *           this the client connection is gone, so a longer observation is not a served
 *           request and finer boundaries above it would describe nothing.
 *
 * KNOWN RESIDUAL, recorded so it is not mistaken for a bug in these numbers. The SSE route
 * `GET /v1/notifications/stream` (`libs/modules/notifications/.../notification-sse.controller.ts`)
 * holds its response open for the life of the browser tab, and its `http.server.duration`
 * observation is a connection lifetime rather than a latency. It will sit in the overflow
 * bucket above 60000. Adding minute-scale rungs to accommodate it was rejected: it would
 * spend cardinality describing a number that is not latency, and the observation is already
 * separable by its route attribute, which is the correct place to exclude it. Note that
 * opshub's `HttpLoggingInterceptor` records no metrics at all, so unlike the sibling product
 * there is no application-side histogram for this route to distort — only this one, from
 * `@opentelemetry/instrumentation-http`.
 *
 * COST. 19 boundaries against the default 15 means four extra `_bucket` series per label
 * combination on one instrument. Negligible next to being able to read the p99 at all.
 */
const HTTP_DURATION_BOUNDARIES_MS = [
  // OTel JS defaults, preserved verbatim.
  0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000,
  // Extensions covering opshub's real request-path timeout budgets.
  15000, 30000, 45000, 60000,
];

// `OTEL_SERVICE_NAME` overrides this, and the stack sets it per service
// (`<product>-api`), so the default is the local-development value.
startOtel({
  defaultServiceName: 'opshub-api',
  httpDurationBoundaries: HTTP_DURATION_BOUNDARIES_MS,
});
