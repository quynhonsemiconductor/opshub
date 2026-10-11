import { Inject, Injectable } from '@nestjs/common';
import { setUserBanned, type Identity } from '@quynhonsemiconductor/identity';
import { AUTH } from '@quynhonsemiconductor/identity/nest';
import type { SessionRevoker } from '@platform';

/**
 * Offboarding on identity 8 (`SessionRevoker`): the leaver's sessions end in the database AND in Valkey and they
 * cannot sign in again, from a service, with no admin session (`setUserBanned`, identity >= 8.1).
 *
 * It REJECTS while the session cache is unavailable (`SessionStoreUnavailableError`) instead of leaving cached
 * sessions behind: the ban is already in place by then (the person cannot sign in again) and the caller sees
 * the failure and can retry, which is the safe direction for an access-removal path.
 */
@Injectable()
export class IdentitySessionRevoker implements SessionRevoker {
  constructor(@Inject(AUTH) private readonly auth: Identity) {}

  async offboard(employeeId: string, reason: string): Promise<void> {
    await setUserBanned(this.auth, employeeId, true, reason);
  }

  async reinstate(employeeId: string): Promise<void> {
    await setUserBanned(this.auth, employeeId, false);
  }
}
