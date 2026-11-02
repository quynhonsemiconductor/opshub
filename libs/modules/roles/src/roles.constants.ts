/** Longest job rank name (`roles.job_ranks.name` is a varchar(80)). */
export const JOB_RANK_NAME_MAX_LENGTH = 80;

/** Highest ordinal a job rank may take; far above any real ladder, a bound against mistaken input. */
export const JOB_RANK_ORDINAL_MAX = 100;

/** Highest amount a single rank benefit may carry; the unit depends on the benefit code. */
export const RANK_BENEFIT_VALUE_MAX = 1000;
