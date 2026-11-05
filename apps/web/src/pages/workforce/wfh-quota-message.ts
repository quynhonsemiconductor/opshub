import type { components } from '@/shared/api/types';

/** The caller's work-from-home quota for one Monday–Sunday week, as the API returns it. */
export type WfhQuota = components['schemas']['WfhQuotaResponseDto'];

/**
 * Describes a week's work-from-home quota in one sentence for the request form.
 *
 * Args:
 *   quota: The quota of the week the request starts in; undefined while it is loading.
 *
 * Returns:
 *   A sentence for the form, or null while there is nothing to say yet. An allowance of zero says so
 *   plainly, because the API refuses such a request.
 */
export function describeWfhQuota(quota: WfhQuota | undefined): string | null {
  if (!quota) return null;
  if (quota.weeklyAllowance <= 0) {
    return 'Your rank has no work-from-home allowance, so a request cannot be filed.';
  }
  const dayLabel = quota.remainingDays === 1 ? 'day' : 'days';
  return `Week of ${quota.weekStart}: ${quota.remainingDays} ${dayLabel} left of ${quota.weeklyAllowance}.`;
}

/**
 * Tells whether a request asking for the given number of days fits the week's remaining quota.
 *
 * Args:
 *   quota: The quota of the week the request starts in; undefined while it is loading.
 *   requestedDays: Working days the request covers in that week.
 *
 * Returns:
 *   False only when the quota is known and cannot cover the days; true while it is unknown, so the
 *   form never blocks on a quota it has not loaded (the API decides either way).
 */
export function fitsWfhQuota(quota: WfhQuota | undefined, requestedDays: number): boolean {
  if (!quota) return true;
  return quota.weeklyAllowance > 0 && requestedDays <= quota.remainingDays;
}
