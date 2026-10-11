/**
 * The work that needs Microsoft Graph, as data. The API enqueues these; only the worker executes them.
 *
 * Kept free of any Graph or Nest import so the API can depend on it without being able to reach Graph.
 */
export const GRAPH_TASK = {
  /** PATCH /users/{id} { accountEnabled } — User.EnableDisableAccount.All + User.Read.All. */
  ACCOUNT_SET_ENABLED: 'entra.account.set_enabled',
  /** POST /users/{id}/revokeSignInSessions — User.RevokeSessions.All. */
  SESSIONS_REVOKE: 'entra.sessions.revoke',
  /** Intune detected-app scan — DeviceManagementManagedDevices.Read.All. */
  SHADOW_IT_SCAN: 'compliance.shadow_it.scan',
  /** Secure Score + baseline controls — SecurityEvents.Read.All. */
  POSTURE_SYNC: 'security.posture.sync',
} as const;

export type GraphTask =
  | { kind: typeof GRAPH_TASK.ACCOUNT_SET_ENABLED; payload: { entraOid: string; enabled: boolean } }
  | { kind: typeof GRAPH_TASK.SESSIONS_REVOKE; payload: { entraOid: string } }
  | { kind: typeof GRAPH_TASK.SHADOW_IT_SCAN; payload: Record<string, never> }
  | { kind: typeof GRAPH_TASK.POSTURE_SYNC; payload: Record<string, never> };

/**
 * A scan or sync already waiting covers a second request for it. Account tasks are never merged: a
 * disable followed by an enable are both meant, in order.
 */
export function dedupeKeyFor(task: GraphTask): string | null {
  return task.kind === GRAPH_TASK.SHADOW_IT_SCAN || task.kind === GRAPH_TASK.POSTURE_SYNC
    ? task.kind
    : null;
}
