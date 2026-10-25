import { createWorkerApp } from '@quynhonsemiconductor/platform-runtime/bootstrap';
import { workerAppOptions } from './worker-options';

// The whole bootstrap lives in the shared library (see apps/api/src/main.ts). Its options are in `worker-options.ts`.
void createWorkerApp(workerAppOptions);
