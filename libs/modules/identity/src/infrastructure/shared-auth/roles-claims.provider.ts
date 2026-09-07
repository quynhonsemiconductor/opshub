import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { InjectDrizzle, type DrizzleDB } from '@platform';
import type { IClaimsProvider, ProductClaims } from '@quynhonsemiconductor/identity';
import { employees } from '../../../../../../db/schema';

/**
 * opshub binding for the shared `IClaimsProvider` port. opshub's authorization
 * model is role-based: the token carries the employee's `roles` (already
 * reconciled from Entra App Roles by {@link EntraRoleProvisioningHook} before
 * this runs), alongside `email` and `name` so the JWT strategy can hydrate the
 * request principal without a second DB read.
 *
 * `contextId` is ignored — opshub is single-tenant.
 */
@Injectable()
export class RolesClaimsProvider implements IClaimsProvider {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  async getClaims(userId: string, _contextId?: string | null): Promise<ProductClaims> {
    const [row] = await this.db
      .select({
        email: employees.email,
        displayName: employees.displayName,
        roles: employees.roles,
      })
      .from(employees)
      .where(eq(employees.id, userId))
      .limit(1);

    if (!row) {
      return { roles: [], email: '', name: '' };
    }

    return {
      roles: row.roles ?? [],
      email: row.email,
      name: row.displayName,
    };
  }
}
