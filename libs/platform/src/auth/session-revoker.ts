/** DI token for the optional {@link SessionRevoker}. Bound by the API's AuthModule; absent in the worker. */
export const SESSION_REVOKER = Symbol('SESSION_REVOKER');

/**
 * What offboarding needs from authentication, as a port: libs/modules/identity (employees) and
 * libs/modules/workforce (the offboarding workflow) must not depend on the identity 8 package or on the
 * API-only auth module, and the worker process, which compiles both, has no auth at all.
 */
export interface SessionRevoker {
  /**
   * End every session of the employee (database AND cache) and block them from signing in. Effective on the
   * next request. Rejects while the session cache is unavailable, rather than leaving cached sessions behind.
   */
  offboard(employeeId: string, reason: string): Promise<void>;
  /** Allow the employee to sign in again (a re-activation). Touches no session. */
  reinstate(employeeId: string): Promise<void>;
}
