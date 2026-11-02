import type { JobRank } from './role.types';
import { RANK_BENEFIT_WFH_WEEKLY_DAYS } from './rank.constants';

/** One benefit of a rank in the shape the API takes. */
export interface RankBenefitInput {
  benefitCode: 'wfh_weekly_days';
  value: number;
}

/**
 * Reads the weekly work-from-home allowance of a rank.
 *
 * Args:
 *   rank: The rank with its benefits.
 *
 * Returns:
 *   The `wfh_weekly_days` value, or null when the rank has no such benefit. Null is not the same as 0 to
 *   a person: it means nobody set one, and the effect on the employee is the same (no allowance).
 */
export function wfhWeeklyDaysOf(rank: Pick<JobRank, 'benefits'>): number | null {
  const benefit = rank.benefits.find((b) => b.benefitCode === RANK_BENEFIT_WFH_WEEKLY_DAYS);
  return benefit ? benefit.value : null;
}

/**
 * Builds the full benefit set to send when the weekly work-from-home allowance changes.
 *
 * The API replaces a rank's whole benefit set, so every other benefit the rank carries is kept and only
 * the work-from-home one is set or removed.
 *
 * Args:
 *   rank: The rank as it is now.
 *   weeklyDays: The new allowance, or null to remove the benefit.
 *
 * Returns:
 *   The benefits to PUT: the rank's other benefits unchanged, plus the allowance when it is not null.
 */
export function benefitsWithWfhWeeklyDays(
  rank: Pick<JobRank, 'benefits'>,
  weeklyDays: number | null,
): RankBenefitInput[] {
  const others = rank.benefits
    .filter((b) => b.benefitCode !== RANK_BENEFIT_WFH_WEEKLY_DAYS)
    .map((b) => ({
      benefitCode: b.benefitCode as RankBenefitInput['benefitCode'],
      value: b.value,
    }));
  return weeklyDays === null
    ? others
    : [...others, { benefitCode: RANK_BENEFIT_WFH_WEEKLY_DAYS, value: weeklyDays }];
}

/**
 * Turns what was typed in the allowance field into a value to send.
 *
 * Args:
 *   text: The field's content; an empty string means "no allowance set".
 *   maxDays: The largest value accepted.
 *
 * Returns:
 *   `{ ok: true, value }` with null for an empty field, or `{ ok: false, message }` naming what is wrong.
 */
export function parseWfhWeeklyDays(
  text: string,
  maxDays: number,
): { ok: true; value: number | null } | { ok: false; message: string } {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, value: null };
  if (!/^\d+$/.test(trimmed)) return { ok: false, message: 'Use a whole number of days.' };
  const days = Number(trimmed);
  if (days > maxDays) return { ok: false, message: `A week has at most ${maxDays} days.` };
  return { ok: true, value: days };
}
