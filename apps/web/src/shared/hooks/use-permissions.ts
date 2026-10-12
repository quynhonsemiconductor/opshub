/**
 * usePermissions — UI capability gating driven by the backend.
 *
 * Design:
 *  - The backend (PolicyGuard + AuthzService) is the single source of truth for
 *    authorization. `/me` returns the user's *effective permission keys* resolved
 *    from their DB role assignments, including the `'*'` super-admin wildcard.
 *  - This hook is a thin reader over that list. It NEVER re-derives permissions
 *    from role names — that previously caused FE/BE drift (e.g. the `admin` role
 *    was unknown to the FE and its entire menu was hidden).
 *  - It is a UI convenience only, NOT a security boundary; every gated action is
 *    independently enforced server-side.
 *
 * Usage:
 *   const { can, hasRole, primaryRole } = usePermissions();
 *   if (can('asset.read')) { ... }   // permission keys match the backend exactly
 *   if (hasRole('it-admin'))  { ... }
 */
import { useMemo } from 'react';
import { useCurrentUser } from './use-current-user';

// ── Wildcard ──────────────────────────────────────────────────────────────────

/** Super-admin permission — grants every capability (mirrors backend WILDCARD_PERMISSION). */
const WILDCARD = '*';

// ── Role priority (for primaryRole / persona-aware UI) ─────────────────────────

const ROLE_PRIORITY: Record<string, number> = {
  admin: 11,
  'it-admin': 10,
  security: 9,
  hr: 8,
  helpdesk: 7,
  auditor: 6,
  manager: 5,
  employee: 1,
};

// ── Types ─────────────────────────────────────────────────────────────────────

export type AppRole =
  'admin' | 'it-admin' | 'security' | 'hr' | 'helpdesk' | 'auditor' | 'manager' | 'employee';

export interface PermissionHelpers {
  /**
   * Check a backend permission key. Returns true when the user holds the
   * wildcard `'*'` or the exact key. Returns false while /me is loading.
   */
  can: (permission: string) => boolean;
  /** Check if the user has a specific role. */
  hasRole: (role: AppRole | string) => boolean;
  /**
   * The user's highest-priority role — drives persona-aware dashboard widgets.
   * Returns 'employee' as a safe default while loading.
   */
  primaryRole: AppRole;
  /** All roles the user holds. */
  roles: string[];
  /** All effective permission keys the user holds (may contain `'*'`). */
  permissions: string[];
  /** True while /me is still loading. */
  isLoading: boolean;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function usePermissions(): PermissionHelpers {
  const { data: me, isLoading } = useCurrentUser();

  return useMemo<PermissionHelpers>(() => {
    const roles: string[] = (me as { roles?: string[] })?.roles ?? [];
    const permissions: string[] = (me as { permissions?: string[] })?.permissions ?? [];
    const permSet = new Set(permissions);
    const isSuperAdmin = permSet.has(WILDCARD);

    // Primary role = highest priority role the user holds
    const primaryRole = roles.reduce<string>(
      (best, r) => ((ROLE_PRIORITY[r] ?? 0) > (ROLE_PRIORITY[best] ?? 0) ? r : best),
      'employee',
    ) as AppRole;

    return {
      can: (perm) => isSuperAdmin || permSet.has(perm),
      hasRole: (role) => roles.includes(role),
      primaryRole,
      roles,
      permissions,
      isLoading,
    };
  }, [me, isLoading]);
}
