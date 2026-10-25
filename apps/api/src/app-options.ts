import type { HttpAppOptions } from '@quynhonsemiconductor/platform-runtime/bootstrap';
import { HTTP_DURATION_BOUNDARIES_MS } from './http-duration-boundaries';

/**
 * The API's bootstrap options, in ONE place: `main.ts` starts the process with them and the logging conformance spec boots the same object, so
 * what is tested is what ships (a spec that re-typed these would keep passing after `main.ts` changed).
 *
 * Import discipline: only a TYPE and the (import-free) duration buckets at the top. The role module and the product modules are imported inside
 * the functions, in the order the bootstrap requires: after OpenTelemetry, the role before `@platform`.
 */
export const apiAppOptions: HttpAppOptions = {
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
};
