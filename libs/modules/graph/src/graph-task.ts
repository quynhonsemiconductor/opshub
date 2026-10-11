/**
 * The work that needs Microsoft Graph, as data. The API enqueues these; only the worker executes them.
 *
 * Kept free of any Graph or Nest import so the API can depend on it without being able to reach Graph.
 *
 * THE API NAMES AN EMPLOYEE, NOT A DIRECTORY OBJECT. An account task carries `{ employeeId }` and
 * nothing else: no Entra id, and no "enable" or "disable". The worker reads that employee's CURRENT status
 * and `entra_oid` from the database when the task runs and sets the account to match, so a task queued
 * before a change of status cannot override it — a stale "enable" can never re-enable someone since
 * offboarded.
 *
 * WHAT THAT DOES NOT MEAN. `employees.entra_oid` is writable through `POST /employees` (by a holder of
 * `employee.write`) and by SSO linking, so the API can still influence WHICH directory object a task acts
 * on, indirectly, by editing a row. The guarantee against that is the worker's: before any change it
 * reads the object and requires its mail or userPrincipalName to equal the employee's email, and
 * dead-letters (alarm, no change) otherwise. See EntraAccountService.
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
 * The worker's heartbeat, in `graph_sync_state`, ONE ROW PER REPLICA (`graph-worker-heartbeat:<pod>`).
 * Each replica writes `enabled` or `disabled` every 30 seconds; the API reads them to tell a caller the
 * truth — Graph is available when ANY replica reported `enabled` within the window, so one misconfigured
 * or crashed replica can neither hide nor fake it: asking for a scan when no worker can run one
 * would answer 202 for work that never happens. A heartbeat older than {@link HEARTBEAT_FRESH_MS} means
 * no worker is up, which is the same answer.
 *
 * Account tasks do NOT consult it: an approved offboarding must queue even while Graph is off, and
 * waits for the worker app.
 */
export const GRAPH_HEARTBEAT_PREFIX = 'graph-worker-heartbeat:';
export const HEARTBEAT_FRESH_MS = 3 * 60_000;

/**
 * LEASES THAT OUTLIVE THEIR CALLS.
 *
 * A relay hides a claimed row from other relays for a lease. If a task's Graph calls can still be in
 * flight after the lease lapsed, a second worker re-claims the row, reads newer state and acts on it,
 * and then the first worker's late call lands on top: a stale "enable" re-enabling an account that was
 * since offboarded, with the first worker's finish refused by the fence and nothing to put it right.
 *
 * So every call has a hard deadline ({@link GRAPH_CALL_TIMEOUT_MS}, enforced in graph-http.ts; the SDK's
 * own retry loop is removed) and every task kind declares the most calls it can make. The lease is
 * derived from those two numbers plus a margin for the database and token acquisition, and a test
 * asserts the arithmetic for every kind.
 */
export const GRAPH_CALL_TIMEOUT_MS = 30_000;
/** Database round trips, token acquisition and scheduling slack on top of the calls themselves. */
export const LEASE_MARGIN_MS = 60_000;
/** A scan reads at most this many pages (100 apps each); more is treated as a runaway and stops. */
export const MAX_SCAN_PAGES = 100;

/** The most Graph calls one run of each kind can make. */
export const GRAPH_TASK_MAX_CALLS: Record<GraphTask['kind'], number> = {
  // GET /users/{id} (identity check), PATCH accountEnabled, POST revokeSignInSessions.
  [GRAPH_TASK.ACCOUNT_RECONCILE]: 3,
  [GRAPH_TASK.SHADOW_IT_SCAN]: MAX_SCAN_PAGES,
  // GET secureScores, GET secureScoreControlProfiles.
  [GRAPH_TASK.POSTURE_SYNC]: 2,
};

/** How long a claimed row of this kind is hidden from other relays. */
export function graphLeaseMs(kind: string): number {
  const calls = (GRAPH_TASK_MAX_CALLS as Record<string, number | undefined>)[kind] ?? 3;
  return calls * GRAPH_CALL_TIMEOUT_MS + LEASE_MARGIN_MS;
}
