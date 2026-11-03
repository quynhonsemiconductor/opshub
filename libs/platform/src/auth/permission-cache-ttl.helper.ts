/**
 * Decides how long a resolved permission set may stay cached.
 *
 * The cache's normal lifetime is a safety net for definition edits. A grant that EXPIRES is different: its end
 * is already known when the set is resolved, so caching past it would keep the permission alive after the
 * moment it was meant to stop — for up to the whole normal lifetime. The set is therefore cached only until the
 * earliest expiry among the grants it contains.
 *
 * Args:
 *   defaultTtlSeconds: The normal lifetime, used when no grant in the set expires.
 *   expiries: The expiry of every grant that went into the set; null for a grant that never expires.
 *   now: The moment the set was resolved; injected so the answer is testable.
 *
 * Returns:
 *   The lifetime in whole seconds, never below 1 (a cache entry cannot live for zero seconds, and a grant that
 *   is about to lapse is re-read within a second) and never above `defaultTtlSeconds`.
 */
export function permissionCacheTtlSeconds(
  defaultTtlSeconds: number,
  expiries: readonly (Date | null)[],
  now: Date,
): number {
  const upcomingExpiries = expiries
    .filter((expiry): expiry is Date => expiry !== null)
    .map((expiry) => expiry.getTime() - now.getTime());
  if (upcomingExpiries.length === 0) return defaultTtlSeconds;
  const secondsUntilFirstExpiry = Math.ceil(Math.min(...upcomingExpiries) / 1000);
  return Math.max(1, Math.min(defaultTtlSeconds, secondsUntilFirstExpiry));
}
