import { Injectable } from '@nestjs/common';
import type { ISsoProvisioningHook, SsoProvisioningContext, User } from '@quynhonsemiconductor/identity';
import { AuthzAdminService } from '@modules/authz';

/** Fallback role granted to any SSO user Entra asserts with no mapped App Role. */
const DEFAULT_ROLE_KEY = 'employee';

/**
 * opshub binding for the shared `ISsoProvisioningHook`. Runs once per SSO login,
 * after the employee is resolved and before claims are read, reconciling the
 * employee's OpsHub RBAC role assignments to match the Entra **App Roles** claim
 * (`syncUserRolesByKeys`). This keeps `employees.roles` — the source the
 * {@link RolesClaimsProvider} stamps into the token — authoritative on every
 * login. Unmapped Entra roles are ignored by the authz layer (fail-safe).
 */
@Injectable()
export class EntraRoleProvisioningHook implements ISsoProvisioningHook {
  constructor(private readonly authzAdmin: AuthzAdminService) {}

  async onUserProvisioned(user: User, context: SsoProvisioningContext): Promise<void> {
    const roleKeys = context.entra.roles.length > 0 ? context.entra.roles : [DEFAULT_ROLE_KEY];
    await this.authzAdmin.syncUserRolesByKeys(user.id, roleKeys, {
      sub: user.id,
      email: user.email,
    });
  }
}
