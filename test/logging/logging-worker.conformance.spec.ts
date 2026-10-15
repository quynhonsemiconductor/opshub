/**
 * Logging conformance, worker: the REAL worker, booted through the shared bootstrap, writes the log contract on EVERY line.
 * See test/e2e/logging-api.e2e.spec.ts for what the check asserts and why. Its own file AND its own vitest project
 * (`pnpm test:logging-worker`, environment: `worker-env.fixture.ts`): the worker's env schema refuses the API-only variables the e2e config sets.
 *
 * The fixture sets `OTEL_SERVICE_NAME` to the API's name on purpose: the api and the worker share one `.env`, and the worker is named by
 * `OTEL_WORKER_SERVICE_NAME`. Every line must say `opshub-worker`.
 */
import 'reflect-metadata';
import { describe, it } from 'vitest';
import { runLoggingConformance } from '@quynhonsemiconductor/observability/testing';
import { prepareWorkerApp } from '@quynhonsemiconductor/platform-runtime/bootstrap';

// The environment is the fixture's (worker-env.fixture.ts); nothing is added here.
const ENV = process.env;

describe('logging conformance: opshub-worker (real module, shared bootstrap)', () => {
  it('every line from boot to close is the log contract, named by OTEL_WORKER_SERVICE_NAME', async () => {
    await runLoggingConformance({
      expected: { service: 'opshub-worker', env: 'develop', version: 'sha-conformance' },
      boot: async (logStream) => ({
        app: await prepareWorkerApp({
          before: async () => {
            await import('../../apps/worker/src/role');
          },
          module: () => import('../../apps/worker/src/worker.module').then((m) => m.WorkerModule),
          env: ENV,
          otel: {
            serviceNameEnvVar: 'OTEL_WORKER_SERVICE_NAME',
            defaultServiceName: 'opshub-worker',
          },
          logStream,
        }),
      }),
    });
  });
});
