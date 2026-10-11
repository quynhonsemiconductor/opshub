/**
 * The work that needs Microsoft Graph, as data. The API enqueues these; only the worker executes them.
 *
 * Kept free of any Graph or Nest import so the API can depend on it without being able to reach Graph.
 *
 * THE API NAMES AN EMPLOYEE, NEVER A DIRECTORY OBJECT. An account task carries `{ employeeId }` and
 * nothing else: the worker reads that employee's CURRENT status and Entra object id from the database
 * and sets the account to match. So the API cannot aim a task at an arbitrary account, and a task that
 * was queued before the employee's status changed still does the right thing when it runs — a stale
 * "enable" can never re-enable someone who has since been offboarded.
 */
export const GRAPH_TASK = {
  /**
   * Make the Entra account match the employee: offboarded => disabled and sessions revoked, otherwise
   * enabled. Level-triggered, so running it twice, or late, is harmless.
   * PATCH /users/{id} (User.EnableDisableAccount.All + User.Read.All), POST /users/{id}/revokeSignInSessions
   * (User.RevokeSessions.All).
   */
  ACCOUNT_RECONCILE: 'entra.account.reconcile',
  /** Intune detected-app scan — DeviceManagementManagedDevices.Read.All. */
  SHADOW_IT_SCAN: 'compliance.shadow_it.scan',
  /** Secure Score + baseline controls — SecurityEvents.Read.All. */
  POSTURE_SYNC: 'security.posture.sync',
} as const;

export type GraphTask =
  | { kind: typeof GRAPH_TASK.ACCOUNT_RECONCILE; payload: { employeeId: string } }
  | { kind: typeof GRAPH_TASK.SHADOW_IT_SCAN; payload: Record<string, never> }
  | { kind: typeof GRAPH_TASK.POSTURE_SYNC; payload: Record<string, never> };

/**
 * A scan or sync already waiting covers a second request for it. Account tasks are never merged.
 */
export function dedupeKeyFor(task: GraphTask): string | null {
  return task.kind === GRAPH_TASK.SHADOW_IT_SCAN || task.kind === GRAPH_TASK.POSTURE_SYNC
    ? task.kind
    : null;
}

/**
 * Tasks that share a key run one at a time, in order. Account tasks are keyed by employee, so two tasks
 * for one person never overlap and the later one always runs after the earlier one has finished.
 */
export function orderingKeyFor(task: GraphTask): string | null {
  return task.kind === GRAPH_TASK.ACCOUNT_RECONCILE ? task.payload.employeeId : null;
}

/**
 * The worker's heartbeat, in `graph_sync_state`. The worker writes `enabled` or `disabled` every 30
 * seconds; the API reads it to tell a caller the truth: asking for a scan when no worker can run one
 * would answer 202 for work that never happens. A heartbeat older than {@link HEARTBEAT_FRESH_MS} means
 * no worker is up, which is the same answer.
 *
 * Account tasks do NOT consult it: an approved offboarding must queue even while Graph is off, and
 * waits for the worker app.
 */
export const GRAPH_HEARTBEAT_STATE = 'graph-worker-heartbeat';
export const HEARTBEAT_FRESH_MS = 3 * 60_000;
