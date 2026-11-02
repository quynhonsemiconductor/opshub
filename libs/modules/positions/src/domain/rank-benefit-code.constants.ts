import type { rankBenefitCodeEnum } from '../../../../../db/schema';

/** Derived from the DB enum so adding a value there cannot leave this list stale. */
export type RankBenefitCode = (typeof rankBenefitCodeEnum.enumValues)[number];

/**
 * The benefit codes a job rank can carry, by name.
 *
 * `WFH_WEEKLY_DAYS` is the number of work-from-home days an employee of the rank may take in one
 * Monday–Sunday week.
 */
export const RANK_BENEFIT_CODE = {
  WFH_WEEKLY_DAYS: 'wfh_weekly_days',
} as const satisfies Record<string, RankBenefitCode>;
