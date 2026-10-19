export const RATE_LIMIT_TIER = Symbol('RATE_LIMIT_TIER');
export const SKIP_RATE_LIMIT = Symbol('SKIP_RATE_LIMIT');

export interface RateLimitTier {
  /** Display name used in logs and RFC 6585 headers */
  name: string;
  /** Sliding-window size in milliseconds */
  windowMs: number;
  /** Max allowed requests within the window */
  limit: number;
}

/**
 * Named tiers for intent-based rate limiting. Each is applied PER AUTHENTICATED USER (`uid:<userId>`), after
 * identity has verified the session. Each name is used by `@RateLimit(...)` declarations: renaming or removing one is a
 * change to every declaration that uses it.
 */
export const RATE_LIMIT_TIERS = {
  /** Default: most read/write endpoints — 200 req/min per user. Configurable downwards in production. */
  DEFAULT: { name: 'DEFAULT', windowMs: 60_000, limit: 200 },
  /** Strict: expensive search/list endpoints — 60 req/min per user */
  STRICT: { name: 'STRICT', windowMs: 60_000, limit: 60 },
  /** AI chat — LLM calls are expensive; 10 req/min per user to cap inference cost. */
  AI: { name: 'AI', windowMs: 60_000, limit: 10 },
  /** File upload presign/confirm — S3 PUT costs; 30 req/min per user. */
  UPLOAD: { name: 'UPLOAD', windowMs: 60_000, limit: 30 },
} as const satisfies Record<string, RateLimitTier>;

export type RateLimitTierName = keyof typeof RATE_LIMIT_TIERS;

/**
 * The PRE-AUTH bucket, per verified client address (`clientIp()`), never per cookie: a cookie is unverified until
 * identity reads it, so a per-cookie bucket could be made fresh with every request. Every request reserves a slot
 * before it runs. Only identity verifying the caller gives the slot back (a signed-in request then leaves no trace), so
 * failed authentications, forged cookies and requests whose connection closed all stay counted. NAT-sized on purpose: an office behind
 * one address shares it, so the ceiling is high enough that a normal day of signed-in traffic never reaches it. It
 * stops one network from flooding the authentication path; it does not bound a signed-in user (the tiers do).
 *
 * RUNBOOK: when this window is full, every caller at that address gets 429 for at most `windowMs`. A mass session
 * revocation can fill it (every client reauthenticates and some fail), and it then clears by itself.
 */
export const PRE_AUTH_IP_BUCKET: RateLimitTier = { name: 'IP', windowMs: 60_000, limit: 1000 };
