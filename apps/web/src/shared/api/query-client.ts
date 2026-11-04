import { QueryClient } from '@tanstack/react-query';
import { STALE } from './cache';
import { RATE_LIMIT_MAX_RETRIES, retryDelayFromError } from './rate-limit-retry';

/**
 * The one query client.
 *
 * WHY IT LIVES HERE rather than inside `app-providers.tsx`. Two things outside React need it: the auth
 * bootstrap, which fetches `GET /v1/auth/me` before the tree mounts and can hand that answer to the
 * cache instead of letting a hook fetch it a second time; and the logout handler, which has to discard
 * one identity's data before another can arrive. Both were previously unable to reach it, and the first
 * of them cost every page load a duplicate request.
 *
 * A module-level singleton, as it already was — one client per browser tab is the point of a cache.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        const status = (error as { status?: number })?.status;
        // A 401 means the session is gone; a 403 means this identity may not have it. Neither gets
        // better by asking again, and retrying them only delays the login redirect or the message.
        if (status === 401 || status === 403) return false;

        /*
         * A 429 is a delay, not a failure. Two more attempts. The generated client already retries
         * 429 reads at the transport layer; this covers errors thrown by queryFns that carry a
         * status, so both paths obey one rule.
         */
        if (status === 429) return failureCount < RATE_LIMIT_MAX_RETRIES;

        return failureCount < 1;
      },
      // The 429 half honours the server's `Retry-After` (or backoff when it sent none), capped by
      // the shared policy. Everything else keeps TanStack's exponential default.
      retryDelay: (failureCount, error) => {
        const status = (error as { status?: number })?.status;
        if (status === 429) return retryDelayFromError(failureCount, error);
        return Math.min(1_000 * 2 ** failureCount, 30_000);
      },
      refetchOnWindowFocus: false,
      /*
       * STATED, NOT INHERITED. This is TanStack's own behaviour, so nothing changes — but half the
       * queries in the SPA set a `staleTime` and half do not, and the half that do not were reading as
       * an omission rather than as a choice. `STALE.NONE` says the choice out loud: refetch on mount,
       * which is right for a list somebody is about to act on and wrong for a reference catalogue.
       * A query that wants otherwise names its tier from the same file.
       */
      staleTime: STALE.NONE,
    },
  },
});
