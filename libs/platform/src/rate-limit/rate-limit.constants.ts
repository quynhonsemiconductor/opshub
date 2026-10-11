export const RATE_LIMIT_TIER = Symbol('RATE_LIMIT_TIER');
export const SKIP_RATE_LIMIT = Symbol('SKIP_RATE_LIMIT');

export interface RateLimitTier {
  /** Display name used in logs and RFC 6585 headers */
  name: string;
  /** Sliding-window size in milliseconds */
  windowMs: number;
  /** Max allowed requests within the window */
  limit: number;
  /**
   * How to derive the rate-limit key.
   * - 'ip'           — client IP; for pre-auth endpoints, where there is no credential yet
   * - 'userId'       — the caller's SESSION: the session cookie, hashed (default)
   *
   * `userId` IS A HISTORICAL NAME. It used to read the decoded JWT `sub`, which is always undefined
   * here: this guard is global and `SessionAuthGuard` is a route guard, so authentication has not run when
   * the limiter executes. Every tier using it silently keyed on the IP instead — see the guard's own
   * docblock for what that cost. The name is kept because the tier table is append-only and renaming a
   * key changes every declaration; what it means is "per caller, not per network".
   */
  keyBy?: 'ip' | 'userId';
}

/**
 * Named tiers for intent-based rate limiting.
 * Append-only — never change the semantics of an existing tier name. (`AUTH_REFRESH` was removed with the
 * refresh-token endpoint it limited: identity 8 has no such route, and no code names the tier.)
 */
export const RATE_LIMIT_TIERS = {
  /**
   * Default: most read/write endpoints — 200 req/min per session.
   *
   * PER SESSION AND NOT PER NETWORK, which is the whole point and was broken until the guard stopped
   * asking for a principal that does not exist yet. Shared across a NAT this bound is meaningless: a
   * page load costs roughly a dozen calls, so one office reached it at about fifteen simultaneous page
   * loads and everybody there started getting 429s at once.
   */
  DEFAULT: { name: 'DEFAULT', windowMs: 60_000, limit: 200 },
  /** Strict: expensive search/list endpoints — 60 req/min per session */
  STRICT: { name: 'STRICT', windowMs: 60_000, limit: 60 },
  /** Auth login: brute-force protection — 5 attempts / 15 min per IP */
  AUTH_LOGIN: { name: 'AUTH_LOGIN', windowMs: 15 * 60_000, limit: 5, keyBy: 'ip' },
  /** AI chat — LLM calls are expensive; 10 req/min per session to cap inference cost. */
  AI: { name: 'AI', windowMs: 60_000, limit: 10, keyBy: 'userId' },
  /** File upload presign/confirm — S3 PUT costs; 30 req/min per session. */
  UPLOAD: { name: 'UPLOAD', windowMs: 60_000, limit: 30, keyBy: 'userId' },
} as const satisfies Record<string, RateLimitTier>;

export type RateLimitTierName = keyof typeof RATE_LIMIT_TIERS;
