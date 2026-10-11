/** DI token for the optional {@link SessionRevoker}. Bound by the API's AuthModule; absent in the worker. */
export const SESSION_REVOKER = Symbol('SESSION_REVOKER');

/**
 * What offboarding needs from authentication, as a port: libs/modules/identity (employees) and
 * libs/modules/workforce (the offboarding workflow) must not depend on the identity 8 package or on the
 * API-only auth module, and the worker process, which compiles both, has no auth at all.
 */
export interface SessionRevoker {
  /**
   * Ban the employee and end every session (database AND cache), through identity. Called AFTER the caller's
   * transaction has already banned them and deleted the session rows (the authoritative step, Postgres only),
   * so what this adds is clearing the cached copies. Rejects while the session cache is unavailable, rather
   * than leaving cached sessions behind; calling it again once the cache is healthy finishes the job.
   */
  offboard(employeeId: string, reason: string): Promise<void>;
  /**
   * Allow the employee to sign in again (a re-activation): drops identity's in-process memory of the ban.
   * The caller's transaction has already lifted it in the database. Touches no session; needs no cache.
   */
  reinstate(employeeId: string): Promise<void>;
}
