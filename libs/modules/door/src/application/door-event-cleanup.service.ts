import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { and, isNull, lt } from 'drizzle-orm';
import { AppConfigService, ExclusiveJob, InjectDrizzle, type DrizzleDB } from '@platform';
import { MS_PER_DAY, MS_PER_HOUR } from '@shared-kernel';
import { events } from '../../../../../db/schema';

/** 23 h — under the daily schedule, so a crashed pod cannot block tomorrow's purge. */
const LOCK_TTL_MS = 23 * MS_PER_HOUR;

/** Unknown-card events: 30 days, FIXED (ADR §2.7). Visitors' bank cards are not records we keep. */
export const UNKNOWN_CARD_RETENTION_DAYS = 30;

/**
 * Nightly retention purge for door events (Law 91/2025/QH15 via ADR ATTENDANCE-DEVICE §2.7).
 *
 * TWO clocks, because the rows are two different kinds of personal data:
 *   - unknown-card events (nobody's swipe — visitors' transit cards, phones) die at 30 days;
 *   - attendance events (an employee's personal data) at `DOOR_EVENT_RETENTION_DAYS`, default
 *     730. HR may set it shorter; lengthening it is a records decision, not a config edit.
 *
 * Registered by `DoorModule`, but the SCHEDULE only exists where `ScheduleModule` does — the
 * worker — so the API process compiles this class and never fires it.
 */
@Injectable()
export class DoorEventCleanupService {
  private readonly logger = new Logger(DoorEventCleanupService.name);
  private readonly retentionDays: number;

  constructor(
    @InjectDrizzle() private readonly db: DrizzleDB,
    private readonly config: AppConfigService,
    private readonly exclusive: ExclusiveJob,
  ) {
    this.retentionDays = this.config.get('DOOR_EVENT_RETENTION_DAYS');
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'door-event-cleanup' })
  async purgeExpiredEvents(): Promise<void> {
    await this.exclusive.run('door-event-cleanup', LOCK_TTL_MS, async () => {
      const now = Date.now();

      const unknownCutoff = new Date(now - UNKNOWN_CARD_RETENTION_DAYS * MS_PER_DAY);
      const unknownRows = await this.db
        .delete(events)
        .where(and(isNull(events.cardId), lt(events.receivedAt, unknownCutoff)))
        .returning({ id: events.id });

      const attendanceCutoff = new Date(now - this.retentionDays * MS_PER_DAY);
      const attendanceRows = await this.db
        .delete(events)
        .where(lt(events.receivedAt, attendanceCutoff))
        .returning({ id: events.id });
      const unknownDeleted = unknownRows.length;
      const attendanceDeleted = attendanceRows.length;

      if (unknownDeleted > 0 || attendanceDeleted > 0) {
        this.logger.log(
          {
            unknownDeleted,
            unknownCutoffDate: unknownCutoff.toISOString(),
            attendanceDeleted,
            attendanceCutoffDate: attendanceCutoff.toISOString(),
            retentionDays: this.retentionDays,
          },
          'Door event cleanup: purged expired records',
        );
      }
    });
  }
}
