import { createHttpApp } from '@quynhonsemiconductor/platform-runtime/bootstrap';
import { HTTP_DURATION_BOUNDARIES_MS } from './http-duration-boundaries';

// The whole bootstrap lives in the shared library: `.env`, OpenTelemetry, the pino logger (JSON from the first line), graceful shutdown and
// the fatal handler. `module` is a function so OpenTelemetry is installed BEFORE pg/http/ioredis are loaded.
void createHttpApp({
  // The process role MUST be declared before `@platform` loads: the config module validates the environment on import, against the
  // schema of the role declared here (the API holds the sign-in secret and refuses any GRAPH_* variable). `before` runs ahead of `module`.
  before: async () => {
    await import('./role');
  },
  module: () => import('./app.module').then((m) => m.AppModule),
  otel: {
    // `OTEL_SERVICE_NAME` overrides this, and the stack sets it per service (`<product>-api`).
    defaultServiceName: 'opshub-api',
    httpDurationBoundaries: HTTP_DURATION_BOUNDARIES_MS,
  },
  http: { bodyLimit: 10 * 1024 * 1024 }, // 10 MB; tighten per-route if needed
  configure: async (app) => {
    const { enableCorrelationId } = await import('@quynhonsemiconductor/platform-http');
    const { bootstrapApp } = await import('./bootstrap/app.bootstrap');
    enableCorrelationId(app);
    await bootstrapApp(app);
  },
});
