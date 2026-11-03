/** Milliseconds in one calendar day; the helpers below work on calendar dates, so no daylight saving applies. */
const _MILLISECONDS_PER_DAY = 86_400_000;

/** Offset of Asia/Ho_Chi_Minh from UTC, in milliseconds — the zone the WFH rules judge dates in. */
const _HO_CHI_MINH_OFFSET_MS = 7 * 3_600_000;

/**
 * Finds the Monday of a week that is some whole weeks from the current one, in Asia/Ho_Chi_Minh.
 *
 * Args:
 *   weeksAhead: How many whole weeks after the current week; 0 is this week's Monday, which is usually in the past.
 *
 * Returns:
 *   That Monday as `YYYY-MM-DD`.
 */
export function mondayAhead(weeksAhead: number): string {
  const nowInHoChiMinh = new Date(Date.now() + _HO_CHI_MINH_OFFSET_MS);
  const isoWeekday = nowInHoChiMinh.getUTCDay() === 0 ? 7 : nowInHoChiMinh.getUTCDay();
  const thisMonday = nowInHoChiMinh.getTime() - (isoWeekday - 1) * _MILLISECONDS_PER_DAY;
  return new Date(thisMonday + weeksAhead * 7 * _MILLISECONDS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * Adds days to a calendar date.
 *
 * Args:
 *   date: A `YYYY-MM-DD` date.
 *   days: How many days to add; negative moves back.
 *
 * Returns:
 *   The resulting `YYYY-MM-DD` date.
 */
export function plusDays(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + days * _MILLISECONDS_PER_DAY)
    .toISOString()
    .slice(0, 10);
}
