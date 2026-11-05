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
 * The floor for every bucket that counts a signed-in person doing normal work: 1200 requests a minute.
 *
 * OpsHub is an internal tool, and the owner's requirement is that it never rate-limits the company while
 * people work fast (2026-11-05). Measured production traffic is tiny — the busiest user-minute in the
 * production API access logs was 4 requests, and the browser E2E suite's synthetic full run peaks at 268
 * on one seat — so 1200 is far above anything a person generates, while still bounding a runaway loop.
 * The buckets that stay tight are the ones where abuse, not speed, is the risk: PRE_AUTH_IP_BUCKET,
 * AI and UPLOAD.
 */
export const AUTHENTICATED_MINUTE_FLOOR = 1200;

/**
 * Named tiers for intent-based rate limiting. Each is applied PER AUTHENTICATED USER (`uid:<userId>`), after
 * identity has verified the session. Each name is used by `@RateLimit(...)` declarations: renaming or removing one is a
 * change to every declaration that uses it.
 *
 * A tier is a BUDGET FOR ONE PERSON, not a security control. Anything that must resist abuse (sign-in,
 * inference, object-storage writes) has its own tight bucket; these do not throttle normal use.
 */
export const RATE_LIMIT_TIERS = {
  /**
   * Default: most read/write endpoints — 1200 req/min per user. The env knob can raise it in a test
   * environment and cannot take it below the floor in production (env.schema.ts enforces that).
   */
  DEFAULT: { name: 'DEFAULT', windowMs: 60_000, limit: AUTHENTICATED_MINUTE_FLOOR },
  /**
   * The session bootstrap — GET /v1/auth/me. Its own bucket on purpose: it runs once per page load,
   * before anything else, so a screen that fans out many reads must not be able to spend the bucket
   * that decides whether the user is signed in. The LIMIT is the DEFAULT floor, not a smaller number:
   * the bootstrap must never be the request that 429s a signed-in person.
   */
  AUTH_ME: { name: 'AUTH_ME', windowMs: 60_000, limit: AUTHENTICATED_MINUTE_FLOOR },
  /**
   * Strict: routes marked as expensive (searches, admin lists, door terminals). It keeps its own bucket
   * so one screen's fan-out cannot spend another's, but the ceiling is the same as DEFAULT: the old
   * 60/min throttled bulk edits and fast navigation, which are normal work.
   */
  STRICT: { name: 'STRICT', windowMs: 60_000, limit: AUTHENTICATED_MINUTE_FLOOR },
  /** AI chat — LLM calls are expensive; 10 req/min per user to cap inference cost. Tight on purpose. */
  AI: { name: 'AI', windowMs: 60_000, limit: 10 },
  /** File upload presign/confirm — S3 PUT costs; 30 req/min per user. Tight on purpose. */
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
