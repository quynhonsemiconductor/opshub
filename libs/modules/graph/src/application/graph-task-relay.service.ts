import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { and, asc, eq, inArray, lt, lte, sql } from 'drizzle-orm';
import {
  AbstractOutboxRelay,
  DeferError,
  ExclusiveJob,
  InjectDrizzle,
  NonRetryableError,
  Span,
} from '@platform';
import type { Claimed, DrizzleDB, DrizzleTx, OutboxLeaseTable } from '@platform';
import { graphTaskOutbox } from '../../../../../db/schema';
import { GRAPH_TASK, graphLeaseMs } from '../graph-task';
import { classifyGraphError } from '../graph-errors';
import { GRAPH_LOCK } from '../graph-locks';
import { GraphClientService } from '../graph-client.service';
import { EntraAccountService } from './entra-account.service';
import { SecureScoreSyncService } from './secure-score-sync.service';
import { ShadowItScanService } from './shadow-it-scan.service';

const MAX_ERROR_LENGTH = 2_000;
/** How long a scan or sync waits when the cron's run (or a crashed one's lock) holds its lock. */
const LOCK_HELD_DELAY_MS = 5 * 60_000;

export interface TaskRow {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  createdAt: Date;
}

/**
 * Performs Graph work the API asked for. WORKER ONLY. Two concrete relays share this body and differ
 * only in WHICH KINDS they claim, so that no account task is ever batched with, or serialized behind, a
 * scan:
 *
 *   {@link GraphAccountRelayService}   account reconciles: seconds each, a 150 s lease, batches of 10
 *   {@link GraphScanRelayService}      scans and syncs: minutes each, a long lease, one at a time
 *
 * Each is its own claim and its own in-flight pass, so an offboarding disable runs while a scan is still
 * in progress, and a worker that crashes holding a scan strands that scan alone.
 *
 * LEASED, NOT LOCKED (see AbstractOutboxRelay). The Graph call happens with no transaction open. The
 * lease of each kind is derived from its call budget and the per-request deadline (graph-task.ts), so it
 * always outlives the calls it covers.
 *
 * ORDERED PER KEY. A row is claimable only while no OTHER row with its ordering key is either earlier and
 * pending (running, backing off, or just not finished) or holding a live lease — the second clause covers
 * commit order differing from `seq` order — and the claim takes a transaction-scoped advisory lock on the
 * key, so two claims racing for the same employee cannot both succeed.
 *
 * WHILE GRAPH IS OFF the relay claims nothing, and rows wait: an offboarding approved before the worker
 * app exists is carried out the day it does.
 */
export abstract class GraphTaskRelay extends AbstractOutboxRelay<TaskRow> {
  protected abstract readonly kinds: readonly string[];

  constructor(
    db: DrizzleDB,
    protected readonly graph: GraphClientService,
    private readonly accounts: EntraAccountService,
    private readonly scan: ShadowItScanService,
    private readonly posture: SecureScoreSyncService,
    private readonly exclusive: ExclusiveJob,
  ) {
    super(db);
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
    return graphLeaseMs(row.kind);
  }

  protected selectDue(tx: DrizzleTx, limit: number, now: Date): Promise<TaskRow[]> {
    if (!this.graph.isEnabled()) return Promise.resolve([]);
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
          inArray(graphTaskOutbox.kind, [...this.kinds]),
          eq(graphTaskOutbox.status, 'pending'),
          lt(graphTaskOutbox.attempts, this.maxAttempts),
          lte(graphTaskOutbox.nextAttemptAt, now),
          this.notLeased(now),
          // One at a time per ordering key. Another row for the key blocks this one if it is EARLIER and
          // still pending, or if it holds a live lease whatever its seq.
          sql`(${graphTaskOutbox.orderingKey} IS NULL OR NOT EXISTS (
            SELECT 1 FROM messaging.graph_task_outbox other
             WHERE other.ordering_key = ${graphTaskOutbox.orderingKey}
               AND other.id <> ${graphTaskOutbox.id}
               AND other.status = 'pending'
               AND (other.seq < ${graphTaskOutbox.seq}
                    OR (other.lease_token IS NOT NULL AND other.locked_until > ${now.toISOString()}::timestamptz))
          ))`,
          // Two claims racing for one key: only the one that takes the lock may take its rows. Held
          // until this claim transaction commits, which is when the lease becomes visible to the other.
          sql`(${graphTaskOutbox.orderingKey} IS NULL OR pg_try_advisory_xact_lock(hashtext(${graphTaskOutbox.orderingKey})))`,
        ),
      )
      .orderBy(asc(graphTaskOutbox.seq), asc(graphTaskOutbox.id))
      .limit(limit)
      .for('update', { skipLocked: true });
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

  /**
   * Runs under the cron's lock. When another run holds it the request is NOT done: that run may be a
   * crashed one whose lock lives for hours, and it may have started before the data this request is
   * about. The row stays pending, the attempt is refunded, and it tries again after a delay.
   */
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
      throw new DeferError(`${lock.name} is held by another run`, LOCK_HELD_DELAY_MS);
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

/** Account tasks: an offboarding disable must never wait behind a scan. */
@Injectable()
export class GraphAccountRelayService extends GraphTaskRelay {
  protected readonly kinds = [GRAPH_TASK.ACCOUNT_RECONCILE];
  protected override readonly batchSize = 10;

  constructor(
    @InjectDrizzle() db: DrizzleDB,
    graph: GraphClientService,
    accounts: EntraAccountService,
    scan: ShadowItScanService,
    posture: SecureScoreSyncService,
    exclusive: ExclusiveJob,
  ) {
    super(db, graph, accounts, scan, posture, exclusive);
  }

  @Cron('*/10 * * * * *', { name: 'graph-account-relay' })
  @Span('graph.account.relay')
  override async relay(): Promise<void> {
    return super.relay();
  }
}

/** Scans and syncs: minutes long, one at a time, on their own claim and their own lease. */
@Injectable()
export class GraphScanRelayService extends GraphTaskRelay {
  protected readonly kinds = [GRAPH_TASK.SHADOW_IT_SCAN, GRAPH_TASK.POSTURE_SYNC];
  protected override readonly batchSize = 1;

  constructor(
    @InjectDrizzle() db: DrizzleDB,
    graph: GraphClientService,
    accounts: EntraAccountService,
    scan: ShadowItScanService,
    posture: SecureScoreSyncService,
    exclusive: ExclusiveJob,
  ) {
    super(db, graph, accounts, scan, posture, exclusive);
  }

  @Cron('*/30 * * * * *', { name: 'graph-scan-relay' })
  @Span('graph.scan.relay')
  override async relay(): Promise<void> {
    return super.relay();
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
