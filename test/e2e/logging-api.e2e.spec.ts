/**
 * Logging conformance, API: the REAL api, booted through the shared bootstrap, writes the log contract on EVERY line.
 *
 * The worker once built the pino logger and never installed it, so Nest wrote `[Nest] 7 - ... LOG [Shutdown]` text and the log pipeline
 * failed to parse every line. No unit test sees that; only booting the real module and reading what it prints does. `runLoggingConformance`
 * captures boot to close and asserts every line is a JSON object with `level` (a label), `time` (ISO-8601), `msg`, `service`,
 * `env` (the DEPLOYMENT env), `version`, that nothing is `[Nest]` text, and that a credential in an SDK-style error is `[REDACTED]`.
 *
 * The worker is in its own file: the process role is module state that `@platform` reads on import, once per process.
 */
import 'reflect-metadata';
import { describe, it } from 'vitest';
import { runLoggingConformance } from '@quynhonsemiconductor/observability/testing';
import { prepareHttpApp } from '@quynhonsemiconductor/platform-runtime/bootstrap';
import { apiAppOptions } from '../../apps/api/src/app-options';

const ENV = {
  ...process.env,
  NODE_ENV: 'production', // pinned to production in every deployed environment, on purpose
  DEPLOYMENT_ENV: 'develop',
  SERVICE_VERSION: 'sha-conformance',
  OTEL_SERVICE_NAME: 'opshub-api',
  LOG_LEVEL: 'info',
  LOG_PRETTY: 'false',
} as NodeJS.ProcessEnv;

describe('logging conformance: opshub-api (real module, shared bootstrap)', () => {
  it('every line from boot to close is the log contract', async () => {
    await runLoggingConformance({
      expected: { service: 'opshub-api', env: 'develop', version: 'sha-conformance' },
      boot: async (logStream) => {
        // The SAME options object main.ts starts the process with; only the environment and the log sink are the test's.
        const app = await prepareHttpApp({ ...apiAppOptions, env: ENV, logStream });
        await app.init();
        await app.getHttpAdapter().getInstance().ready();
        return {
          app,
          request: async () => {
            const http = app.getHttpAdapter().getInstance();
            await http.inject({ method: 'GET', url: '/livez' });
            await http.inject({ method: 'GET', url: '/v1/nope' });
          },
        };
      },
    });
  });
});
