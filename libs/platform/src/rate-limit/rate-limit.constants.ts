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
 * identity has verified the session. Append-only: never change the semantics of an existing tier name.
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
 * The PRE-AUTH bucket: every request, authenticated or not, is counted against its client address before any
 * credential is looked at. It is NAT-sized on purpose: an office behind one address shares it, so it is set
 * high enough that a normal day of page loads never reaches it. Its job is to stop one network from flooding
 * the authentication path and from minting unlimited unverified credentials; it does not bound a signed-in
 * user (the tiers above do). Keyed by the verified address from `clientIp()`, never by a cookie: a cookie is
 * unverified until identity reads it, so a per-cookie bucket could be made fresh with every request.
 */
export const PRE_AUTH_IP_BUCKET: RateLimitTier = { name: 'IP', windowMs: 60_000, limit: 1000 };
