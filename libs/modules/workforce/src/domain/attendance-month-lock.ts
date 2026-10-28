import { sql } from 'drizzle-orm';
import { ErrorCodes, PreconditionFailedException, type DbExecutor } from '@platform';

/** The months the closed range `[startDate, endDate]` falls into, sorted. */
export function monthsOfRange(startDate: string, endDate: string): string[] {
  const months = new Set<string>();
  let [y, m] = startDate.split('-').map(Number) as [number, number];
  const [ey, em] = endDate.split('-').map(Number) as [number, number];
  while (y < ey || (y === ey && m <= em)) {
    months.add(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) {
      y += 1;
      m = 1;
    }
  }
  return [...months].sort();
}

/**
 * The month lock, enforced where the decision actually lands: INSIDE the engine's transaction,
 * from the type-def hooks — not only in the service the product routes call.
 *
 * WHY THERE. The universal `/requests/:id/approve|reject|cancel` routes reach the same hooks, so a
 * closed month refuses a decision whichever door it comes through; a service-level check alone is
 * bypassable by every generic route. The check runs in the engine's tx, so it commits or rolls
 * back with the decision.
 *
 * WHY AN ADVISORY LOCK FIRST. `closeMonth` inserts the close row in its own transaction; a
 * SELECT-then-decide here cannot see an uncommitted insert, so an approve racing a close could
 * pass this check and commit either side of it. `pg_advisory_xact_lock` on the month's key
 * serializes the two — `closeMonth` takes the same lock before inserting — so whichever commits
 * second sees the truth. Transaction-scoped, so it releases itself.
 */
export async function assertMonthsOpenInTx(
  tx: DbExecutor,
  startDate: string,
  endDate: string,
  action: string,
): Promise<void> {
  for (const month of monthsOfRange(startDate, endDate)) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`attendance_month:${month}`}))`);
    const closed = await tx.execute(
      sql`select 1 from workforce.attendance_month_closes where month = ${month}`,
    );
    if (closed.rows.length > 0) {
      throw new PreconditionFailedException(
        ErrorCodes.ATTENDANCE_MONTH_CLOSED,
        `${action} touches ${month}, which HR closed — an administrator must reopen the month first`,
      );
    }
  }
}

/** The same advisory locks `assertMonthsOpenInTx` takes, for the writer of the close row. */
export async function lockMonthsInTx(tx: DbExecutor, month: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`attendance_month:${month}`}))`);
}
