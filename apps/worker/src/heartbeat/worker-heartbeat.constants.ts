/**
 * The heartbeat contract, in one dependency-free file: the worker writes it and `scripts/local/check.ts` reads it, so both import
 * these values instead of repeating them.
 */

/** How often a live worker writes its beat. A replica that stops beating is reported down once its key expires. */
export const WORKER_HEARTBEAT_INTERVAL_MS = 30_000;
/** Longer than three intervals, so one slow write does not look like a dead worker. */
export const WORKER_HEARTBEAT_TTL_SECONDS = 90;
/** One key per replica (`hostname` is the pod name in the cluster). The check command and the alerts read this prefix. */
export const WORKER_HEARTBEAT_KEY_PREFIX = 'worker:heartbeat:';
