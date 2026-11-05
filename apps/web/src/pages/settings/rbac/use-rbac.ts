import { useQuery } from '@tanstack/react-query';
import { api } from '@/shared/api/client';
import type { PermissionResponse, GroupResponse } from '@/shared/api/types';

/**
 * The two reads every RBAC tab shares.
 *
 * Their own module, not `rbac-shared.tsx`: that file exports COMPONENTS, and eslint's
 * `react-refresh/only-export-components` is right that mixing hooks in costs Fast Refresh for them.
 */

export function useGroups() {
  return useQuery<GroupResponse[]>({
    queryKey: ['authz', 'groups'],
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/authz/groups');
      if (error || !data) throw new Error('Failed to load groups');
      return data as GroupResponse[];
    },
  });
}

/**
 * The permission CATALOGUE — every permission key the product defines, for populating a picker.
 *
 * NOT WHAT THE CALLER HOLDS, and the name is emphatic about it because the old one was not. This was
 * `usePermissions()`, which is also the name of `@/shared/hooks/use-permissions` — the hook 33 other
 * call sites use to ask what the SIGNED-IN USER may do. `groups-tab.tsx` imported this one, so the file
 * read as though it consulted the caller's permissions while it was in fact listing the vocabulary,
 * and every reviewer who scanned for a gate found the import and moved on.
 *
 * That is what the shadowing cost: the five write controls on this screen shipped with no permission
 * check at all. `it-admin` and `auditor` hold `rbac.read`, so they reached the screen, were offered New
 * group, Delete, Add permission, Assign group and Revoke, and were refused by the API on every one of
 * them. The name is the whole reason nobody noticed, so it now says what it returns.
 */
export function usePermissionCatalogue() {
  return useQuery<PermissionResponse[]>({
    queryKey: ['authz', 'permissions'],
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/authz/permissions');
      if (error || !data) throw new Error('Failed to load permissions');
      return data as PermissionResponse[];
    },
  });
}
