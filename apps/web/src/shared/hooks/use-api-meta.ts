/**
 * The running API's version, from `GET /v1/meta`.
 *
 * Paired with `ENV.APP_VERSION` (the web image tag the chart rendered into `/config.json`) so the
 * sidebar can state BOTH versions. They disagree during a half-rolled deploy, which is exactly the
 * moment a reader needs to see it rather than a single number that hides which half moved.
 *
 * The endpoint is authenticated and cheap; it is on the DEFAULT rate-limit tier, so a footer read
 * cannot spend a tighter budget.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '@/shared/api/client';
import { STALE } from '@/shared/api/cache';
import type { components } from '@/shared/api/generated/api';

export type ApiMetaDto = components['schemas']['MetaResponseDto'];

export const API_META_QUERY_KEY = ['meta'] as const;

export function useApiMeta() {
  return useQuery<ApiMetaDto>({
    queryKey: API_META_QUERY_KEY,
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/meta');
      if (error || !data) throw new Error('Failed to load the API version');
      return data as ApiMetaDto;
    },
    staleTime: STALE.REPORT,
    retry: 1,
  });
}
