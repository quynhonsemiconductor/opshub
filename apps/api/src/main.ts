import { createHttpApp } from '@quynhonsemiconductor/platform-runtime/bootstrap';
import { apiAppOptions } from './app-options';

// The whole bootstrap lives in the shared library: `.env`, OpenTelemetry, the pino logger (JSON from the first line), graceful shutdown and
// the fatal handler. This product supplies only what is its own, in `app-options.ts`.
void createHttpApp(apiAppOptions);
