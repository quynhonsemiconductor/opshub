import { SetMetadata } from '@nestjs/common';
import { RATE_LIMIT_TIER, SKIP_RATE_LIMIT, type RateLimitTierName } from './rate-limit.constants';

/**
 * Override the rate-limit tier for a route or controller.
 * @example  @RateLimit('AI')
 */
export const RateLimit = (tier: RateLimitTierName) => SetMetadata(RATE_LIMIT_TIER, tier);

/** Bypass rate limiting entirely (e.g. health probes). */
export const SkipRateLimit = () => SetMetadata(SKIP_RATE_LIMIT, true);
