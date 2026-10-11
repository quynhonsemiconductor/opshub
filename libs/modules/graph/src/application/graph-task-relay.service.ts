import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { and, asc, eq, lt, lte, sql } from 'drizzle-orm';
import {
  AbstractOutboxRelay,
  ExclusiveJob,
  InjectDrizzle,
  NonRetryableError,
  Span,
} from '@platform';
import type { Claimed, DrizzleDB, DrizzleTx, OutboxLeaseTable } from '@platform';
import { graphTaskOutbox } from '../../../../../db/schema';
import { GRAPH_TASK } from '../graph-task';
import { classifyGraphError } from '../graph-errors';
import { GRAPH_LOCK } from '../graph-locks';
import { GraphClientService } from '../graph-client.service';
import { EntraAccountService } from './entra-account.service';
import { SecureScoreSyncService } from './secure-score-sync.service';
import { ShadowItScanService } from './shadow-it-scan.service';

const MAX_ERROR_LENGTH = 2_000;
const MINUTE_MS = 60_000;

interface TaskRow {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  createdAt: Date;
}

/** Scans and syncs walk a whole inventory and can run for many minutes; account tasks take seconds. */
const LONG_KINDS: ReadonlySet<string> = new Set([
  GRAPH_TASK.SHADOW_IT_SCAN,
  GRAPH_TASK.POSTURE_SYNC,
]);

/**
 * Performs the Graph work the API asked for. WORKER ONLY.
 *
 * LEASED, NOT LOCKED (see AbstractOutboxRelay). The Graph call happens with no transaction open, so a
 * 20-minute scan holds a lease, not a row lock and a database session — it cannot trip the role's
 * idle_in_transaction_session_timeout. Scans and syncs get a long lease; account tasks a short one.
 *
 * ORDERED PER EMPLOYEE. A row is claimable only when no earlier row with the same ordering key is still
 * pending, so at most one account task per employee is in flight and they run in `seq` order.
 *
 * SAME LOCK AS THE CRON. A queued scan or sync takes the `ExclusiveJob` lock the scheduled one takes, so
 * the two cannot overlap and raise duplicate findings. If the other run holds it, this request is
 * covered by that run and the row is done.
 *
 * WHILE GRAPH IS OFF the relay claims nothing, and rows wait: an offboarding approved before the worker
 * app exists is carried out the day it does.
 */
@Injectable()
export class GraphTaskRelayService extends AbstractOutboxRelay<TaskRow> {
  /** Small batches: a long task ends its batch (see selectDue) and the rest wait for the next pass. */
  protected override readonly batchSize = 10;

  constructor(
    @InjectDrizzle() db: DrizzleDB,
    private readonly graph: GraphClientService,
    private readonly accounts: EntraAccountService,
    private readonly scan: ShadowItScanService,
    private readonly posture: SecureScoreSyncService,
    private readonly exclusive: ExclusiveJob,
  ) {
    super(db);
  }

  @Cron('*/10 * * * * *', { name: 'graph-task-relay' })
  @Span('graph.task.relay')
  override async relay(): Promise<void> {
    return super.relay();
  }

  protected readonly outbox: OutboxLeaseTable = {
    table: graphTaskOutbox,
    id: graphTaskOutbox.id,
    status: graphTaskOutbox.status,
    attempts: graphTaskOutbox.attempts,
    lastError: graphTaskOutbox.lastError,
    leaseToken: graphTaskOutbox.leaseToken,
    lockedUntil: graphTaskOutbox.lockedUntil,
    seq: graphTaskOutbox.seq,
  };

  protected leaseMsFor(row: TaskRow): number {
    return LONG_KINDS.has(row.kind) ? 60 * MINUTE_MS : 3 * MINUTE_MS;
  }

  protected async selectDue(tx: DrizzleTx, limit: number, now: Date): Promise<TaskRow[]> {
    if (!this.graph.isEnabled()) return [];
    const rows = await tx
      .select({
        id: graphTaskOutbox.id,
        kind: graphTaskOutbox.kind,
        payload: graphTaskOutbox.payload,
        attempts: graphTaskOutbox.attempts,
        createdAt: graphTaskOutbox.createdAt,
      })
      .from(graphTaskOutbox)
      .where(
        and(
          eq(graphTaskOutbox.status, 'pending'),
          lt(graphTaskOutbox.attempts, this.maxAttempts),
          lte(graphTaskOutbox.nextAttemptAt, now),
          this.notLeased(now),
          // At most one in flight per ordering key, in seq order: an earlier row still pending (running,
          // backing off, or just not finished) holds back every later row for the same employee.
          sql`(${graphTaskOutbox.orderingKey} IS NULL OR NOT EXISTS (
            SELECT 1 FROM messaging.graph_task_outbox earlier
             WHERE earlier.ordering_key = ${graphTaskOutbox.orderingKey}
               AND earlier.status = 'pending'
               AND earlier.seq < ${graphTaskOutbox.seq}
          ))`,
        ),
      )
      .orderBy(asc(graphTaskOutbox.seq))
      .limit(limit)
      .for('update', { skipLocked: true });

    // A long task ends the batch: the rows behind it would wait out its whole run holding a lease they
    // are not using.
    const firstLong = rows.findIndex((r) => LONG_KINDS.has(r.kind));
    return firstLong === -1 ? rows : rows.slice(0, firstLong + 1);
  }

  protected async deliver(row: Claimed<TaskRow>): Promise<void> {
    try {
      switch (row.kind) {
        case GRAPH_TASK.ACCOUNT_RECONCILE:
          return await this.accounts.reconcile(employeeId(row.payload));
        case GRAPH_TASK.SHADOW_IT_SCAN:
          return await this.exclusively(GRAPH_LOCK.SHADOW_IT, async () => {
            await this.scan.detectShadowIt();
          });
        case GRAPH_TASK.POSTURE_SYNC:
          return await this.exclusively(GRAPH_LOCK.POSTURE, async () => {
            await this.posture.runPostureSync();
          });
        default:
          throw new NonRetryableError(`Unknown Graph task kind: ${row.kind}`);
      }
    } catch (err) {
      throw classifyGraphError(err);
    }
  }

  /** Runs under the cron's lock. When another run holds it, that run covers this request. */
  private async exclusively(
    lock: { name: string; ttlMs: number },
    work: () => Promise<void>,
  ): Promise<void> {
    let ran = false;
    await this.exclusive.run(lock.name, lock.ttlMs, async () => {
      ran = true;
      await work();
    });
    if (!ran) {
      this.logger.log(`${lock.name} is already running — this request is covered by that run`);
    }
  }

  protected async markSent(tx: DrizzleTx, row: Claimed<TaskRow>): Promise<void> {
    await tx
      .update(graphTaskOutbox)
      .set({ status: 'sent', sentAt: new Date(), lastError: null })
      .where(eq(graphTaskOutbox.id, row.id));
  }

  protected async markFailed(
    tx: DrizzleTx,
    row: Claimed<TaskRow>,
    newStatus: 'pending' | 'failed',
    error: string,
    nextAttemptAt: Date,
  ): Promise<void> {
    await tx
      .update(graphTaskOutbox)
      .set({ status: newStatus, lastError: error.slice(0, MAX_ERROR_LENGTH), nextAttemptAt })
      .where(eq(graphTaskOutbox.id, row.id));
  }
}

/** The employee a task is about; a malformed payload fails the row rather than guessing. */
function employeeId(payload: Record<string, unknown>): string {
  const value = payload['employeeId'];
  if (typeof value !== 'string' || value.length === 0) {
    throw new NonRetryableError('Graph task payload has no employeeId');
  }
  return value;
}
