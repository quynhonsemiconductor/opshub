import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ExclusiveJob } from '@platform';
import { NotificationSchedulerService } from '@platform';
import { InjectDrizzle, type DrizzleDB } from '@platform';
import { AttendanceService } from '@modules/workforce';

/** Under the daily cadence with room for a retry after a crash. */
const LOCK_TTL_MS = 6 * 60 * 60_000;

/**
 * The morning attendance sweep: tell every employee about THEIR OWN unresolved flags from
 * yesterday, while a justification can still be filed.
 *
 * 00:30 UTC = 07:30 Asia/Ho_Chi_Minh — morning, and safely past local midnight so "yesterday"
 * is settled. "Yesterday" is computed in HCM, not on the runner's clock.
 *
 * Nothing is stored per day and no state is kept: the sweep recomputes yesterday from the same
 * derivation the month view uses, and each notification is deduplicated by idempotency key
 * (`attendance_flags:{date}:{employeeId}`), so a re-run or a second pod cannot double-notify.
 * Weekends and holidays produce no flags (the derivation only covers working days), so the sweep
 * simply finds nothing and sends nothing.
 */
@Injectable()
export class AttendanceFlagsCron {
  private readonly logger = new Logger(AttendanceFlagsCron.name);

  constructor(
    @InjectDrizzle() private readonly db: DrizzleDB,
    private readonly attendance: AttendanceService,
    private readonly notifScheduler: NotificationSchedulerService,
    private readonly exclusive: ExclusiveJob,
  ) {}

  @Cron('30 0 * * *', { name: 'attendance-flags' })
  async tick(): Promise<void> {
    // ExclusiveJob, because `@Cron` fires on every replica: the idempotency keys deduplicate the
    // notifications, but a second run would double the queries for nothing.
    await this.exclusive.run('attendance-flags', LOCK_TTL_MS, async () => {
      // The PREVIOUS WORKING day, not calendar-yesterday: Monday morning reports Friday, and
      // the morning after a holiday reports the last day anybody was expected in.
      const yesterday = await this.attendance.previousWorkingDay();
      const flagged = await this.attendance.unresolvedFlagsFor(yesterday);
      if (flagged.length === 0) return;

      let notified = 0;
      for (const person of flagged) {
        try {
          await this.db.transaction(async (tx) => {
            await this.notifScheduler.schedule(tx, {
              type: 'attendance.flags_unresolved',
              vars: { date: yesterday, flags: person.flags },
              recipientId: person.employeeId,
              resourceId: yesterday,
              idempotencyKey: `attendance_flags:${yesterday}:${person.employeeId}`,
            });
          });
          notified++;
        } catch (err) {
          this.logger.error(
            { err, employeeId: person.employeeId, date: yesterday },
            'Attendance flag notification failed — skipping',
          );
        }
      }
      this.logger.log(`${notified} employee(s) have unresolved attendance flags for ${yesterday}`);
    });
  }
}
