/** The benefit code that carries the work-from-home days an employee of a rank may take in one week. */
export const RANK_BENEFIT_WFH_WEEKLY_DAYS = 'wfh_weekly_days';

/** Most work-from-home days a week can hold: Monday to Sunday. The API allows more; no real week does. */
export const WFH_WEEKLY_DAYS_MAX = 7;

/** Longest rank name the API accepts (`roles.job_ranks.name` is a varchar(80)). */
export const RANK_NAME_MAX_LENGTH = 80;
