import { Inject, Injectable } from '@nestjs/common';
import { setUserBanned, type Identity } from '@quynhonsemiconductor/identity';
import { AUTH } from '@quynhonsemiconductor/identity/nest';
import type { SessionRevoker } from '@platform';

/**
 * Offboarding on identity 8 (`SessionRevoker`): the leaver's sessions end in the database AND in Valkey and they
 * cannot sign in again, from a service, with no admin session (`setUserBanned`, identity >= 8.1).
 *
 * The caller has ALREADY banned the user and deleted the session rows in its own transaction (the authoritative
 * step, which needs only Postgres), so this is the cache half: it clears the copies in Valkey and drops
 * identity's in-process memory of the user. It REJECTS while the session cache is unavailable
 * (`SessionStoreUnavailableError`), before changing anything of its own; the caller sees the failure and
 * retries, which re-applies the (idempotent) ban and finishes the job once the cache is healthy.
 *
 * Residual window, accepted: while Valkey was down a cached session could not be cleared, and when it comes
 * back that copy is refused as soon as identity re-reads the user (it believes "not banned" for at most 30 s
 * per process). The retry above closes it at once.
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
