/** Last day of a `YYYY-MM` month, as `YYYY-MM-DD`. Day 0 of the next month is the last of this one. */
export function lastDayOf(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
