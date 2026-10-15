import { createScriptLogger } from '@quynhonsemiconductor/observability';

/**
 * The logger for the migrator, the seeds and the ops scripts: the same JSON lines as the apps (`level` label, ISO `time`, `service`, `env`,
 * `version`), so a migration failure in CloudWatch/Loki is queryable like any other line. `service` is `OTEL_SERVICE_NAME` when the task sets one.
 */
export const log = createScriptLogger('opshub-migrator');
