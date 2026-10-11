import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { InjectDrizzle, type DrizzleDB } from '@platform';
import { AuthzAdminService } from '@modules/authz';
import { newId } from '@shared-kernel';
import { employees } from '../../../../../../db/schema';

/** Fallback role granted to any signed-in person Entra asserts with no mapped App Role. */
export const DEFAULT_ROLE_KEY = 'employee';

/**
 * Thrown to refuse a sign-in: identity redirects the browser with `?error=STAFF_SIGN_IN_REFUSED` and mints no
 * session. The message reaches the log, never the browser.
 */
export class StaffSignInRefusedError extends Error {
  override readonly name = 'StaffSignInRefusedError';
}

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
 * 0. AN OFFBOARDED EMPLOYEE IS REFUSED, before anything is written. The identity ban already stops them, but
 *    the ban and the employee status are two rows and this is the cheap, independent second check: whatever
 *    left them out of step (a failed cache clear, a hand edit, a restore), Entra still lets a leaver in until
 *    their account is disabled, and the product must not. A person with NO employee row is not refused:
 *    that is v7's just-in-time provisioning, kept on purpose (any member of the tenant signs in; see 1).
 *
 * A failure of any step fails the sign-in, which is the right way round: a session with stale roles is the
 * one thing this must not produce.
 */
@Injectable()
export class StaffSignInHandler {
  constructor(
    @InjectDrizzle() private readonly db: DrizzleDB,
    private readonly authzAdmin: AuthzAdminService,
  ) {}

  async handle({ user, claims }: StaffSignIn): Promise<void> {
    await this.refuseIfOffboarded(user);
    await this.ensureEmployee(user, claims.oid);
    const roleKeys = claims.roles.length > 0 ? claims.roles : [DEFAULT_ROLE_KEY];
    await this.authzAdmin.syncUserRolesByKeys(user.id, roleKeys, {
      sub: user.id,
      email: user.email,
    });
  }

  private async refuseIfOffboarded(user: { id: string; email: string }): Promise<void> {
    const [row] = await this.db
      .select({ status: employees.status })
      .from(employees)
      .where(eq(employees.id, user.id))
      .limit(1);
    if (row?.status === 'offboarded') {
      throw new StaffSignInRefusedError(`sign-in refused: employee ${user.id} is offboarded`);
    }
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
