/**
 * usePermissions — UI capability gating driven by the backend.
 *
 * Design:
 *  - The backend (PolicyGuard + AuthzService) is the single source of truth for
 *    authorization. `/me` returns the user's *effective permission keys* resolved
 *    from their DB group memberships and direct grants, including the `'*'` super-admin wildcard.
 *  - This hook is a thin reader over that list. It NEVER re-derives permissions
 *    from group names — that previously caused FE/BE drift (e.g. the `admin` group
 *    was unknown to the FE and its entire menu was hidden).
 *  - It is a UI convenience only, NOT a security boundary; every gated action is
 *    independently enforced server-side.
 *
 * Usage:
 *   const { can, hasGroup, primaryGroup } = usePermissions();
 *   if (can('asset.read')) { ... }   // permission keys match the backend exactly
 *   if (hasGroup('it-admin')) { ... }
 */
import { useMemo } from 'react';
import { useCurrentUser } from './use-current-user';

// ── Wildcard ──────────────────────────────────────────────────────────────────

/** Super-admin permission — grants every capability (mirrors backend WILDCARD_PERMISSION). */
const WILDCARD = '*';

// ── Group priority (for primaryGroup / persona-aware UI) ─────────────────────────

const GROUP_PRIORITY: Record<string, number> = {
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

export type GroupKey =
  'admin' | 'it-admin' | 'security' | 'hr' | 'helpdesk' | 'auditor' | 'manager' | 'employee';

export interface PermissionHelpers {
  /**
   * Check a backend permission key. Returns true when the user holds the
   * wildcard `'*'` or the exact key. Returns false while /me is loading.
   */
  can: (permission: string) => boolean;
  /** Check if the user belongs to a specific group. */
  hasGroup: (group: GroupKey | string) => boolean;
  /**
   * The user's highest-priority group — drives persona-aware dashboard widgets.
   * Returns 'employee' as a safe default while loading.
   */
  primaryGroup: GroupKey;
  /** All groups the user belongs to. */
  groups: string[];
  /** All effective permission keys the user holds (may contain `'*'`). */
  permissions: string[];
  /** True while /me is still loading. */
  isLoading: boolean;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function usePermissions(): PermissionHelpers {
  const { data: me, isLoading } = useCurrentUser();

  return useMemo<PermissionHelpers>(() => {
    const groups: string[] = (me as { groups?: string[] })?.groups ?? [];
    const permissions: string[] = (me as { permissions?: string[] })?.permissions ?? [];
    const permSet = new Set(permissions);
    const isSuperAdmin = permSet.has(WILDCARD);

    // Primary group = highest priority group the user belongs to
    const primaryGroup = groups.reduce<string>(
      (best, r) => ((GROUP_PRIORITY[r] ?? 0) > (GROUP_PRIORITY[best] ?? 0) ? r : best),
      'employee',
    ) as GroupKey;

    return {
      can: (perm) => isSuperAdmin || permSet.has(perm),
      hasGroup: (group) => groups.includes(group),
      primaryGroup,
      groups,
      permissions,
      isLoading,
    };
  }, [me, isLoading]);
}
