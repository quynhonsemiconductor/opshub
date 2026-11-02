/**
 * Work-from-home days per week an employee gets when their rank carries no `wfh_weekly_days` benefit, or
 * they hold no ranked position at all.
 *
 * Zero on purpose: the rule is "log work from home only while the quota is above zero", so an employee
 * nobody has granted an allowance to has none. Raising this is a one-line change that gives every
 * unranked employee a default allowance.
 */
export const WFH_WEEKLY_DAYS_WITHOUT_BENEFIT = 0;

/** Offset of Asia/Ho_Chi_Minh from UTC, in hours — fixed, Vietnam has no daylight saving. */
export const HO_CHI_MINH_UTC_OFFSET_HOURS = 7;
