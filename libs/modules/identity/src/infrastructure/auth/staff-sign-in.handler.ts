import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { InjectDrizzle, type DrizzleDB } from '@platform';
import { AuthzAdminService } from '@modules/authz';
import { newId } from '@shared-kernel';
import { employees } from '../../../../../../db/schema';

/** Fallback role granted to any signed-in person Entra asserts with no mapped App Role. */
export const DEFAULT_ROLE_KEY = 'employee';

/** What identity's `hooks.onStaffSignIn` hands over (see `StaffSignInClaims` in the package). */
export interface StaffSignIn {
  user: { id: string; email: string; name: string };
  claims: { oid: string; roles: string[] };
}

/**
 * The product's half of a Microsoft sign-in, run by identity's `hooks.onStaffSignIn` on EVERY sign-in, after
 * the identity user exists and before its session is returned. A throw refuses the sign-in (no session).
 *
 *  1. THE EMPLOYEE EXISTS, with the user's id. A person HR created has one already (UserDirectory gave the
 *     user the employee's id). An unknown person from the tenant gets one now (v7's just-in-time provisioning):
 *     `id = user.id`, so the two tables stay one person. `employees.entra_oid` is recorded, as v7 did at login:
 *     the employee API and the Graph code read it.
 *  2. THE ROLES FOLLOW ENTRA, exactly as in v7: the App Roles of the id_token (`admin`, `it-admin`, ...) are
 *     reconciled into the global role assignments by `AuthzAdminService.syncUserRolesByKeys` on every sign-in,
 *     and a token with no role is `employee`. A role key that matches nothing is ignored by the authz layer
 *     (an unmapped Entra role never grants access). Authorization itself is not read from the token: `PolicyGuard`
 *     resolves permissions from the database on every request.
 *
 * A failure of either step fails the sign-in, which is the right way round: a session with stale roles is the
 * one thing this must not produce.
 */
@Injectable()
export class StaffSignInHandler {
  constructor(
    @InjectDrizzle() private readonly db: DrizzleDB,
    private readonly authzAdmin: AuthzAdminService,
  ) {}

  async handle({ user, claims }: StaffSignIn): Promise<void> {
    await this.ensureEmployee(user, claims.oid);
    const roleKeys = claims.roles.length > 0 ? claims.roles : [DEFAULT_ROLE_KEY];
    await this.authzAdmin.syncUserRolesByKeys(user.id, roleKeys, {
      sub: user.id,
      email: user.email,
    });
  }

  private async ensureEmployee(
    user: { id: string; email: string; name: string },
    oid: string,
  ): Promise<void> {
    const email = user.email.toLowerCase();
    await this.db
      .insert(employees)
      .values({
        id: user.id || newId(),
        email,
        displayName: user.name || email,
        entraOid: oid,
      })
      .onConflictDoUpdate({
        target: employees.id,
        // the display name stays what HR (or the first sign-in) set; only the Entra link is refreshed
        set: { entraOid: oid, updatedAt: sql`now()` },
      });
  }
}
