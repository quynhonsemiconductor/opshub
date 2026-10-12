import { Injectable } from '@nestjs/common';
import { eq, or, sql } from 'drizzle-orm';
import { InjectDrizzle, type DrizzleDB } from '@platform';
import { AuthzAdminService } from '@modules/authz';
import { newId } from '@shared-kernel';
import { employees } from '../../../../../../db/schema';
import { isStaffEmail } from './staff-domains';

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
  claims: {
    /** The Entra object id. */
    oid: string;
    /** The address the id_token carried. */
    email: string;
    /** Whether the token is for a B2B guest (identity refuses these before the hook unless `allowGuests`). */
    guest: boolean;
    /** The Entra App Roles claim; empty when the token carries none. */
    roles: string[];
  };
}

/**
 * The product's half of a Microsoft sign-in, run by identity's `hooks.onStaffSignIn` on EVERY sign-in, after
 * the identity user exists and before its session is returned. A throw refuses the sign-in (no session).
 *
 * THE ACCESS MODEL (owner decision; "Assignment required" is OFF on the Entra app because the whole company
 * uses OpsHub):
 *   - anyone in the company tenant with a `qnsc.vn` address signs in and is provisioned as `employee`;
 *   - elevated roles come ONLY from Entra App Role assignments, reconciled on every sign-in;
 *   - guests, other tenants, other domains and offboarded employees are refused.
 * identity enforces the tenant, the domain and the guest rule BEFORE this hook; the hook repeats the domain and
 * guest rule (it costs nothing and does not depend on identity's configuration staying as it is) and owns the
 * rest.
 *
 *  0. REFUSE, before anything is written:
 *     - a guest, or an address off the staff domain (defence in depth, see above);
 *     - an OFFBOARDED employee, found by user id, by Entra object id AND by email. The lookup is not by user id
 *       alone because that is exactly what fails when the identity user was deleted or never backfilled: Better
 *       Auth then creates a NEW user with a new id, and a lookup by that id finds nobody. Entra still lets a
 *       leaver in until their account is disabled, and the product must not;
 *     - an employee who exists under ANOTHER id than the identity user: `identity.user.id = identity.employees.id`
 *       is the invariant every foreign key depends on, and providing a second identity for one person would
 *       silently break it. This is the "user deleted or never backfilled" case for an ACTIVE employee. It fails
 *       closed, with the reason in the log, until the user row is repaired.
 *     A person with NO employee row at all is not refused: that is v7's just-in-time provisioning, the access
 *     path of this model (see 1).
 *  1. THE EMPLOYEE EXISTS, with the user's id. A person HR created has one already (UserDirectory gave the
 *     user the employee's id). Anyone else from the tenant gets one now: `id = user.id`, `entra_oid` recorded
 *     (the employee API and the Graph code read it), and no role of their own.
 *  2. THE ROLES FOLLOW ENTRA, on every sign-in: the App Roles of the id_token are reconciled into the global
 *     role assignments by `AuthzAdminService.syncUserRolesByKeys`. A person is never granted more than the token
 *     names: with no role claim (or only roles opshub does not know) they hold `employee` and nothing else, and
 *     a role removed in Entra is revoked here at their next sign-in. Authorization itself is not read from the
 *     token: `PolicyGuard` resolves permissions from the database on every request.
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
    this.refuseOutsideStaff(user, claims);
    await this.refuseIfNotAllowed(user, claims.oid);
    await this.ensureEmployee(user, claims.oid);
    await this.authzAdmin.syncUserRolesByKeys(
      user.id,
      claims.roles,
      { sub: user.id, email: user.email },
      DEFAULT_ROLE_KEY,
    );
  }

  private refuseOutsideStaff(user: StaffSignIn['user'], claims: StaffSignIn['claims']): void {
    if (claims.guest) {
      throw new StaffSignInRefusedError(`sign-in refused: guest account (user ${user.id})`);
    }
    // both the token's address and the identity user's: they are the same person by construction, so a
    // difference is itself a reason to stop
    if (!isStaffEmail(claims.email) || !isStaffEmail(user.email)) {
      throw new StaffSignInRefusedError(
        `sign-in refused: address off the staff domain (user ${user.id})`,
      );
    }
  }

  private async refuseIfNotAllowed(user: StaffSignIn['user'], oid: string): Promise<void> {
    const found = await this.db
      .select({ id: employees.id, status: employees.status })
      .from(employees)
      .where(
        or(
          eq(employees.id, user.id),
          eq(sql`lower(${employees.email})`, user.email.toLowerCase()),
          eq(employees.entraOid, oid),
        ),
      );

    const offboarded = found.find((row) => row.status === 'offboarded');
    if (offboarded) {
      throw new StaffSignInRefusedError(
        `sign-in refused: employee ${offboarded.id} is offboarded (matched user ${user.id})`,
      );
    }
    const elsewhere = found.find((row) => row.id !== user.id);
    if (elsewhere) {
      throw new StaffSignInRefusedError(
        `sign-in refused: employee ${elsewhere.id} matches this person but the identity user is ${user.id}; ` +
          'identity.user.id must equal identity.employees.id (repair or recreate the user row)',
      );
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
