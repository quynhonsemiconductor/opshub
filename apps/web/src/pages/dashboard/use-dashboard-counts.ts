import { useQuery } from '@tanstack/react-query';
import { api } from '@/shared/api/client';
import { STALE } from '@/shared/api/cache';

/**
 * The five counts the dashboard tiles read.
 *
 * Each is `limit: 1` and takes `pageInfo.total` — the cheapest way to ask "how many" against a paged
 * endpoint, and the reason none of these needs a dedicated count route.
 *
 * `STALE.ACTIVITY` on all of them: a home screen that refetched five counts on every mount would be
 * five requests for numbers nobody watches change by the second.
 */

/** Every count, keyed. One hook per tile would mean each persona listing the ones it wants. */
export interface DashboardCounts {
  assets: CountResult;
  myQueue: CountResult;
  pendingAccess: CountResult;
  openFindings: CountResult;
  pendingLeave: CountResult;
}

export interface CountResult {
  data: number | undefined;
  isLoading: boolean;
  /**
   * WHETHER THE COUNT COULD BE READ AT ALL — which this type had no way to express.
   *
   * `isError` was absent from the interface, not merely unhandled, so no tile *could* report a failure
   * however carefully it was written. A 403 or a dropped request left `data` undefined, and an
   * undefined value renders as an em dash — pixel-identical to the tiles that deliberately carry no
   * count. So on the first screen everybody sees, a failure and a design decision looked the same.
   *
   * That matters most for the alert-styled tiles: "Awaiting my approval —" reads as "nothing awaiting
   * you", which is the reassuring answer and the wrong one.
   */
  isError: boolean;
}

function useTotal(key: string[], fetch: () => Promise<number>): CountResult {
  const q = useQuery({ queryKey: key, queryFn: fetch, staleTime: STALE.ACTIVITY });
  return { data: q.data, isLoading: q.isLoading, isError: q.isError };
}

/**
 * All five, always.
 *
 * Called unconditionally rather than per persona, because React hooks cannot be called conditionally
 * and a persona-specific subset would mean seven components each wiring its own — which is what the
 * page did, and it is why two personas were fetching a count they never displayed.
 */
export function useDashboardCounts(): DashboardCounts {
  return {
    assets: useTotal(['assets', 'count'], async () => {
      const { data, error } = await api.GET('/v1/assets', { params: { query: { limit: 1 } } });
      if (error || !data) throw new Error('Failed to count assets');
      return data.pageInfo?.total ?? 0;
    }),

    /*
     * `myQueue`, not `mine`.
     *
     * This asked for `mine: true`, which is not a parameter the API has — `ListRequestsQuerySchema`
     * defines `myQueue` — so it was stripped and the tile counted EVERY pending request rather than
     * the caller's. It reads "Awaiting my approval". On the seeded database the two numbers happen to
     * match, because admin is the assignee for everything, which is exactly why nobody noticed.
     */
    myQueue: useTotal(['requests', 'my-queue-count'], async () => {
      const { data, error } = await api.GET('/v1/requests', {
        params: { query: { limit: 1, myQueue: true } },
      });
      if (error || !data) throw new Error('Failed to count my queue');
      return data.pageInfo?.total ?? 0;
    }),

    pendingAccess: useTotal(['access-requests', 'pending-count'], async () => {
      const { data, error } = await api.GET('/v1/access-requests', {
        params: { query: { limit: 1, status: 'pending' } },
      });
      if (error || !data) throw new Error('Failed to count pending access');
      return data.pageInfo?.total ?? 0;
    }),

    openFindings: useTotal(['compliance', 'open-findings-count'], async () => {
      const { data, error } = await api.GET('/v1/compliance/findings', {
        params: { query: { limit: 1, status: 'open' } },
      });
      if (error || !data) throw new Error('Failed to count findings');
      return data.pageInfo?.total ?? 0;
    }),

    pendingLeave: useTotal(['workforce', 'pending-leave-count'], async () => {
      const { data, error } = await api.GET('/v1/workforce/leave', {
        params: { query: { limit: 1, status: 'pending' } },
      });
      if (error || !data) throw new Error('Failed to count pending leave');
      return data.pageInfo?.total ?? 0;
    }),
  };
}
