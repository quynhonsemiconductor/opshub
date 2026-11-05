import type { EffectivePermissions } from '@platform';
import { permissionGrants } from '@shared-kernel';

/**
 * Decides whether a holder of the given effective permissions may hand out one permission directly.
 *
 * The rule is no privilege escalation: the grantor must hold the permission themselves, and hold it
 * UNCONSTRAINED. A permission held only for one department cannot be passed on as a global one, because the
 * grantee would end up with more reach than the grantor has. The `*` wildcard and a module-wide grant such
 * as `asset.*` count as holding what they cover, decided by the catalogue's `permissionGrants`.
 *
 * Args:
 *   grantorPermissions: The grantor's effective permissions, as resolved by `AuthzService.resolve`.
 *   permissionKey: The permission being granted.
 *
 * Returns:
 *   True when the grantor holds `permissionKey` in the global scope, directly or through a wildcard.
 */
export function mayGrantPermission(
  grantorPermissions: EffectivePermissions,
  permissionKey: string,
): boolean {
  return Object.entries(grantorPermissions).some(
    ([heldKey, scopes]) =>
      permissionGrants([heldKey], permissionKey) && scopes.some((scope) => scope.type === 'global'),
  );
}
