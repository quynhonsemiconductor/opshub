export * from './health.controller';

/**
 * `Span` comes from the shared package rather than a local copy.
 *
 * The local one hard-coded its tracer name as `'opshub-api'`, so every span the WORKER
 * produced was attributed to the api — and no test or type error could show that, because
 * a mislabelled span is still a valid span. The package derives the tracer from
 * `OTEL_SERVICE_NAME` (falling back to `qnsc`) and carries `SERVICE_VERSION`, which is the
 * same fix rally made after hitting it.
 *
 * Re-exported here rather than changed at the call sites: all four `@Span(...)` usages pass
 * an explicit name, so the package's different DEFAULT (bare method name, versus
 * `Class.method`) reaches nothing. Importing from `@platform` keeps working unchanged.
 *
 * Safe to reach the package's ROOT barrel here, unlike each app's own `otel.ts`, which must
 * use the `/otel` subpath. This module is only loaded via the app modules, long after the
 * OTel bootstrap has installed its instrumentation.
 */
export { Span } from '@quynhonsemiconductor/observability';
