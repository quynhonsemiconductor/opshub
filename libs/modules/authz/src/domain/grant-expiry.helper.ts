/**
 * Whether a time-boxed grant has run out.
 *
 * Args:
 *   expiresAt: When the grant ends, or `null` for one that never does.
 *   now: The instant to judge it at.
 *
 * Returns:
 *   True when `expiresAt` is at or before `now`; a grant with no expiry never expires.
 */
export function isGrantExpired(expiresAt: Date | null, now: Date): boolean {
  return expiresAt !== null && expiresAt.getTime() <= now.getTime();
}
