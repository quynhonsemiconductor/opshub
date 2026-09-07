/**
 * OpenTelemetry bootstrap for the WORKER — must be the very first import in main.ts, so
 * auto-instrumentation patches pg, ioredis and the AWS SDK before any module loads them.
 * The relays are precisely the code whose latency and failures no request trace covers.
 *
 * Shared implementation, from `@quynhonsemiconductor/observability/otel` — see apps/api/src/otel.ts for
 * why the subpath rather than the package root, and for what the local copy this replaced
 * had drifted behind.
 *
 * The default service name differs from the api's, which is the whole reason this file
 * exists separately rather than both apps importing one shared bootstrap: with a single
 * default, a worker whose `OTEL_SERVICE_NAME` was unset would report itself as the api and
 * its spans would land under the wrong service. The stack does set it per service, so this
 * is the local-development default — but a default that is wrong only when configuration is
 * missing is the kind that goes unnoticed.
 */
import { shutdownOtel, startOtel } from '@quynhonsemiconductor/observability/otel';

export { shutdownOtel };

/*
 * `serviceNameEnvVar` IS WHY `OTEL_WORKER_SERVICE_NAME` EXISTS, and it was never passed.
 *
 * The variable is declared in the env schema with a default and listed in `.env.example`, so it reads as
 * the knob for naming the worker — and nothing read it. The shared bootstrap takes the env var NAME as an
 * option precisely so two services in one repo can be named independently; without it the worker falls
 * back to `OTEL_SERVICE_NAME`, which is the api's variable, and the docblock above describes exactly that
 * failure without noticing the wiring was missing.
 *
 * Deployed environments were unaffected: the stack sets `OTEL_SERVICE_NAME` per task, so the worker was
 * correctly named there. What was broken is local and any environment that sets only the worker variable.
 */
startOtel({
  serviceNameEnvVar: 'OTEL_WORKER_SERVICE_NAME',
  defaultServiceName: 'opshub-worker',
});
