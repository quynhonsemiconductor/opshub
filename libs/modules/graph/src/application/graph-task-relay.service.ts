import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { and, asc, eq, lt, lte } from 'drizzle-orm';
import { AbstractOutboxRelay, InjectDrizzle, Span } from '@platform';
import type { DrizzleDB, DrizzleTx, PostCommitTask } from '@platform';
import { graphTaskOutbox } from '../../../../../db/schema';
import { GRAPH_TASK } from '../graph-task';
import { GraphClientService } from '../graph-client.service';
import { EntraAccountService } from './entra-account.service';
import { ShadowItScanService } from './shadow-it-scan.service';
import { SecureScoreSyncService } from './secure-score-sync.service';

const MAX_ERROR_LENGTH = 2_000;

interface TaskRow {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  createdAt: Date;
}

/**
 * Performs the Graph work the API asked for. WORKER ONLY.
 *
 * Retries with the base class's backoff (30 s doubling, five attempts) and dead-letters through the
 * same `outboxDeadLetter` log field the CloudWatch alarm already watches — so a disable that never
 * went through pages someone, where before it was a log line inside an approval request.
 *
 * WHILE GRAPH IS OFF the relay claims nothing, and rows wait. An offboarding approved before the
 * worker app exists is still carried out the day it does; a skipped task would be an account that was
 * never disabled, with nothing recording that.
 */
@Injectable()
export class GraphTaskRelayService extends AbstractOutboxRelay<TaskRow> {
  constructor(
    @InjectDrizzle() db: DrizzleDB,
    private readonly graph: GraphClientService,
    private readonly accounts: EntraAccountService,
    private readonly scan: ShadowItScanService,
    private readonly posture: SecureScoreSyncService,
  ) {
    super(db);
  }

  @Cron('*/10 * * * * *', { name: 'graph-task-relay' })
  @Span('graph.task.relay')
  override async relay(): Promise<void> {
    return super.relay();
  }

  protected async fetchBatch(tx: DrizzleTx): Promise<TaskRow[]> {
    if (!this.graph.isEnabled()) return [];
    return tx
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
          lte(graphTaskOutbox.nextAttemptAt, new Date()),
        ),
      )
      .orderBy(asc(graphTaskOutbox.createdAt), asc(graphTaskOutbox.id))
      .limit(this.batchSize)
      .for('update', { skipLocked: true });
  }

  protected async processRow(row: TaskRow, _tx: DrizzleTx): Promise<PostCommitTask | void> {
    const payload = row.payload;
    switch (row.kind) {
      case GRAPH_TASK.ACCOUNT_SET_ENABLED:
        return void (await this.accounts.setEnabled(oid(payload), payload['enabled'] === true));
      case GRAPH_TASK.SESSIONS_REVOKE:
        return void (await this.accounts.revokeSessions(oid(payload)));
      case GRAPH_TASK.SHADOW_IT_SCAN:
        return void (await this.scan.detectShadowIt());
      case GRAPH_TASK.POSTURE_SYNC:
        return void (await this.posture.runPostureSync());
      default:
        throw new Error(`Unknown Graph task kind: ${row.kind}`);
    }
  }

  protected async markSent(tx: DrizzleTx, rowId: string): Promise<void> {
    await tx
      .update(graphTaskOutbox)
      .set({ status: 'sent', sentAt: new Date(), lastError: null })
      .where(eq(graphTaskOutbox.id, rowId));
  }

  protected async markFailed(
    tx: DrizzleTx,
    rowId: string,
    newAttempts: number,
    newStatus: 'pending' | 'failed',
    error: string,
    nextAttemptAt: Date,
  ): Promise<void> {
    await tx
      .update(graphTaskOutbox)
      .set({
        status: newStatus,
        attempts: newAttempts,
        lastError: error.slice(0, MAX_ERROR_LENGTH),
        nextAttemptAt,
      })
      .where(eq(graphTaskOutbox.id, rowId));
  }
}

/** The directory object id a task acts on; a malformed payload fails the row rather than guessing. */
function oid(payload: Record<string, unknown>): string {
  const value = payload['entraOid'];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Graph task payload has no entraOid');
  }
  return value;
}
