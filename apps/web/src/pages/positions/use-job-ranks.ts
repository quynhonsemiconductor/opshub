import { useQuery } from '@tanstack/react-query';
import { api } from '@/shared/api/client';
import type { JobRank } from './position.types';

/** Query key every job-rank query lives under, so one invalidation refreshes them all. */
export const JOB_RANKS_QUERY_KEY = ['job-ranks'] as const;

/**
 * Loads every job rank with its benefits, most junior first.
 *
 * Returns:
 *   The react-query result; `data` is the list of ranks once loaded.
 */
export function useJobRanks() {
  return useQuery({
    queryKey: [...JOB_RANKS_QUERY_KEY, 'list'],
    queryFn: async (): Promise<JobRank[]> => {
      const { data, error } = await api.GET('/v1/job-ranks');
      if (error || !data) throw new Error('Failed to load job ranks');
      return data;
    },
  });
}

/**
 * Builds a lookup from rank id to rank name, for tables that carry only a `rankId`.
 *
 * Args:
 *   ranks: The loaded job ranks; undefined while loading.
 *
 * Returns:
 *   A map from rank id to rank name; empty while the ranks are loading.
 */
export function rankNamesById(ranks: JobRank[] | undefined): Map<string, string> {
  return new Map((ranks ?? []).map((rank) => [rank.id, rank.name]));
}
