import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { sql, type SQL } from 'drizzle-orm';
import { AppConfigService, InjectDrizzle, DrizzleDB, ExclusiveJob } from '@platform';
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
    timeColumn: 'terminal_at',
    policy: 'terminal + 30 days',
    where: sql`status NOT IN ('pending', 'bounced', 'complained') AND terminal_at < now() - interval '30 days'`,
  },
  {
    name: 'email-outbox',
    table: 'messaging.email_outbox',
    timeColumn: 'terminal_at',
    policy: 'terminal + 30 days (bounced/complained kept)',
    // bounced/complained is the only delivery evidence the email-status view has: NEVER purged.
    where: sql`status NOT IN ('pending', 'bounced', 'complained') AND terminal_at < now() - interval '30 days'`,
  },
  {
    name: 'graph-outbox',
    table: 'messaging.graph_task_outbox',
    timeColumn: 'terminal_at',
    policy: 'terminal + 30 days',
    where: sql`status NOT IN ('pending', 'bounced', 'complained') AND terminal_at < now() - interval '30 days'`,
  },
  {
    name: 'webhook-deliveries',
    table: 'messaging.webhook_deliveries',
    timeColumn: 'terminal_at',
    policy: 'terminal + 30 days',
    where: sql`status NOT IN ('pending', 'bounced', 'complained') AND terminal_at < now() - interval '30 days'`,
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

interface BackfillRule {
  table: string;
  /** Terminal timestamp for rows that predate `terminal_at`; NEVER created/scheduled time. */
  stamp: SQL;
}

/**
 * Historical rows already terminal before this release have `terminal_at` NULL, and every retention
 * predicate is `terminal_at < cutoff` — NULL never matches. Without this phase the whole existing
 * backlog is invisible to both the dry run and the purge. A row with no terminal timestamp at all
 * (a failed row written before the relays stamped anything) gets `now()`: it then ages a full
 * window from this deploy instead of being counted as old from creation.
 */
const BACKFILL_RULES: readonly BackfillRule[] = [
  {
    table: 'messaging.notification_outbox',
    stamp: sql`COALESCE(dispatched_at, now())`,
  },
  {
    table: 'messaging.email_outbox',
    stamp: sql`COALESCE(feedback_at, sent_at, now())`,
  },
  { table: 'messaging.graph_task_outbox', stamp: sql`COALESCE(sent_at, now())` },
  { table: 'messaging.webhook_deliveries', stamp: sql`COALESCE(delivered_at, now())` },
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
    private readonly config: AppConfigService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_4AM, { name: 'retention-cleanup' })
  async purge(): Promise<void> {
    await this.exclusive.run('retention-cleanup', LOCK_TTL_MS, async () => {
      // FIRST PHASE: repair historical terminal rows so the counts (and the purge) see the whole
      // backlog. Idempotent; each batch is its own statement, so each commits and no ADD COLUMN /
      // table lock is held across it. Safe under dry run: it touches only NULL metadata.
      await this.backfillTerminalAt();

      // Ships TRUE: the first production run COUNTS and logs, it does not delete. Flip with
      // RETENTION_DRY_RUN=false once the counts look right.
      const dryRun = this.config.get('RETENTION_DRY_RUN');
      for (const rule of RETENTION_RULES) {
        try {
          if (dryRun) {
            const wouldDelete = await this.countRule(rule);
            this.logger.log(
              { table: rule.table, wouldDelete, policy: rule.policy, dryRun: true },
              'Retention cleanup: dry run',
            );
            continue;
          }
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

  /** Batches every historical terminal row into `terminal_at`; returns rows stamped per table. */
  async backfillTerminalAt(): Promise<void> {
    for (const rule of BACKFILL_RULES) {
      try {
        let total = 0;
        for (let batch = 0; batch < MAX_BATCHES; batch++) {
          const result = (await this.db.execute(sql`
            UPDATE ${sql.raw(rule.table)} t
               SET terminal_at = ${rule.stamp}
             WHERE t.id IN (
               SELECT id FROM ${sql.raw(rule.table)}
                WHERE status <> 'pending' AND terminal_at IS NULL
                LIMIT ${BATCH_SIZE}
             )
          `)) as unknown as { rowCount: number | null };
          const updated = result.rowCount ?? 0;
          total += updated;
          if (updated < BATCH_SIZE) break;
        }
        if (total > 0) {
          this.logger.log(
            { table: rule.table, backfilled: total },
            'Retention cleanup: backfilled terminal_at',
          );
        }
      } catch (err) {
        this.logger.error({ err, table: rule.table }, 'Retention backfill failed for a table');
      }
    }
  }

  /** Dry run: the SAME predicate as the delete, counted and logged. */
  private async countRule(rule: RetentionRule): Promise<number> {
    const result = (await this.db.execute(
      sql`SELECT count(*)::int AS count FROM ${sql.raw(rule.table)} WHERE ${rule.where}`,
    )) as unknown as { rows?: Array<{ count: number }> };
    return result.rows?.[0]?.count ?? 0;
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
