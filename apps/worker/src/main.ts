import { createWorkerApp } from '@quynhonsemiconductor/platform-runtime/bootstrap';

// The whole bootstrap lives in the shared library (see apps/api/src/main.ts). The worker has no HTTP server, so it records no
// `http.server.duration` and passes no histogram boundaries.
void createWorkerApp({
  // Declares this process as the worker BEFORE `@platform` loads (the worker holds the Graph credential and refuses ENTRA_CLIENT_SECRET).
  before: async () => {
    await import('./role');
  },
  module: () => import('./worker.module').then((m) => m.WorkerModule),
  otel: {
    // The api and the worker share one `.env`; the worker is named by its own variable, which is what OTEL_WORKER_SERVICE_NAME is for.
    // OpenTelemetry and the logger both read it, so a log line and a span agree on the service.
    serviceNameEnvVar: 'OTEL_WORKER_SERVICE_NAME',
    defaultServiceName: 'opshub-worker',
  },
});
