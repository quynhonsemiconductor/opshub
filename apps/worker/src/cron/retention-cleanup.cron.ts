import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { sql, type SQL } from 'drizzle-orm';
import { InjectDrizzle, DrizzleDB, ExclusiveJob } from '@platform';
import { MS_PER_HOUR } from '@shared-kernel';

/** 23 h — under the daily schedule, so a crashed pod cannot block tomorrow's purge. */
const LOCK_TTL_MS = 23 * MS_PER_HOUR;

/** Rows per DELETE. A bounded batch keeps one nightly run from holding a long transaction. */
const BATCH_SIZE = 5_000;
/** At most 100k rows per table per night; a backlog drains over several runs, never hours. */
const MAX_BATCHES = 20;

interface RetentionRule {
  name: string;
  table: string;
  /** The column the partial/retention index is built on. */
  timeColumn: string;
  /** Human-readable cap, for the log line and product-docs/RETENTION.md. */
  policy: string;
  /** The delete predicate. Days are fixed per rule; this is SQL, never user input. */
  where: SQL;
}

/**
 * App-table retention (owner "ok retention" 2026-11-06). Only tables that grow WITHOUT BOUND
 * and whose rows stop being needed are listed here.
 *
 * Deliberately NOT purged: audit_logs (730 d, AuditCleanupService), door events (30 d,
 * DoorEventCleanupService), and every business record (requests, approvals, audits, risks,
 * incidents, documents, timesheets). Those are records of a decision, not telemetry.
 *
 * MCP has no app table: its logs are the API access log (Grafana Loki retention, owned by the
 * observability lane) and its only in-process state is the 5 s single-use call token.
 */
export const RETENTION_RULES: readonly RetentionRule[] = [
  {
    name: 'sessions',
    table: 'identity.session',
    timeColumn: 'expires_at',
    policy: 'expired session + 7 days',
    where: sql`expires_at < now() - interval '7 days'`,
  },
  {
    name: 'verification-tokens',
    table: 'identity.verification',
    timeColumn: 'expires_at',
    policy: 'expired token + 7 days',
    where: sql`expires_at < now() - interval '7 days'`,
  },
  {
    name: 'notification-outbox',
    table: 'messaging.notification_outbox',
    timeColumn: 'scheduled_at',
    policy: 'terminal + 30 days',
    where: sql`status <> 'pending' AND scheduled_at < now() - interval '30 days'`,
  },
  {
    name: 'email-outbox',
    table: 'messaging.email_outbox',
    timeColumn: 'sent_at',
    policy: 'terminal + 30 days',
    where: sql`status <> 'pending' AND coalesce(sent_at, scheduled_at) < now() - interval '30 days'`,
  },
  {
    name: 'graph-outbox',
    table: 'messaging.graph_task_outbox',
    timeColumn: 'created_at',
    policy: 'terminal + 30 days',
    where: sql`status <> 'pending' AND created_at < now() - interval '30 days'`,
  },
  {
    name: 'webhook-deliveries',
    table: 'messaging.webhook_deliveries',
    timeColumn: 'created_at',
    policy: 'terminal + 30 days',
    where: sql`status <> 'pending' AND created_at < now() - interval '30 days'`,
  },
  {
    name: 'in-app-notifications',
    table: 'notifications.in_app_notifications',
    timeColumn: 'created_at',
    policy: '365 days',
    where: sql`created_at < now() - interval '365 days'`,
  },
  {
    name: 'secure-score-snapshots',
    table: 'security_posture.secure_score_snapshots',
    timeColumn: 'created_at',
    policy: '90 days (trend window)',
    where: sql`created_at < now() - interval '90 days'`,
  },
  {
    name: 'baseline-checks',
    table: 'security_posture.baseline_checks',
    timeColumn: 'checked_at',
    policy: '90 days (drift window)',
    where: sql`checked_at < now() - interval '90 days'`,
  },
];

/**
 * Nightly batched purge of the unbounded app tables.
 *
 * Each table is independent: a failure is logged and the sweep continues, so one bad table
 * cannot starve the others. Deletes are bounded (LIMIT + ORDER BY the retention column) and
 * idempotent (re-running deletes nothing new). `ExclusiveJob` supplies the cross-pod lock —
 * this job DELETES rows, so two pods must never race it.
 */
@Injectable()
export class RetentionCleanupCron {
  private readonly logger = new Logger(RetentionCleanupCron.name);

  constructor(
    @InjectDrizzle() private readonly db: DrizzleDB,
    private readonly exclusive: ExclusiveJob,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_4AM, { name: 'retention-cleanup' })
  async purge(): Promise<void> {
    await this.exclusive.run('retention-cleanup', LOCK_TTL_MS, async () => {
      for (const rule of RETENTION_RULES) {
        try {
          const deleted = await this.purgeRule(rule);
          if (deleted > 0) {
            this.logger.log(
              { table: rule.table, deleted, policy: rule.policy },
              'Retention cleanup: purged expired rows',
            );
          }
        } catch (err) {
          this.logger.error({ err, table: rule.table }, 'Retention cleanup failed for a table');
        }
      }
    });
  }

  /** Deletes in bounded batches; returns the total removed. */
  private async purgeRule(rule: RetentionRule): Promise<number> {
    let total = 0;
    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const statement = sql`
        DELETE FROM ${sql.raw(rule.table)}
        WHERE id IN (
          SELECT id FROM ${sql.raw(rule.table)}
          WHERE ${rule.where}
          ORDER BY ${sql.raw(rule.timeColumn)}
          LIMIT ${BATCH_SIZE}
        )
      `;
      const result = (await this.db.execute(statement)) as unknown as {
        rowCount: number | null;
      };
      const deleted = result.rowCount ?? 0;
      total += deleted;
      if (deleted < BATCH_SIZE) break;
    }
    return total;
  }
}
