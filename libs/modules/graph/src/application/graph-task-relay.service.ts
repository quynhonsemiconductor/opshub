import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { and, asc, eq, inArray, lt, lte, sql, type SQL } from 'drizzle-orm';
import {
  AbstractOutboxRelay,
  DB_NOW,
  DeferError,
  dbDelay,
  ExclusiveJob,
  InjectDrizzle,
  NonRetryableError,
  Span,
} from '@platform';
import type { Claimed, DrizzleDB, DrizzleTx, OutboxLeaseTable } from '@platform';
import { graphTaskOutbox } from '../../../../../db/schema';
import { GRAPH_TASK, GRAPH_WAKE, graphLeaseMs } from '../graph-task';
import { classifyGraphError } from '../graph-errors';
import { GRAPH_LOCK } from '../graph-locks';
import { GraphClientService } from '../graph-client.service';
import { EntraAccountService } from './entra-account.service';
import { SecureScoreSyncService } from './secure-score-sync.service';
import { ShadowItScanService } from './shadow-it-scan.service';

const MAX_ERROR_LENGTH = 2_000;
/** How long a scan or sync waits when the cron's run (or a crashed one's lock) holds its lock. */
const LOCK_HELD_DELAY_MS = 5 * 60_000;
/** Slack beyond the lock's TTL before a deferred request gives up. */
export const LOCK_WAIT_MARGIN_MS = 10 * 60_000;

export interface TaskRow {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  createdAt: Date;
  /**
   * Milliseconds since the request was queued, measured by the DATABASE when the row was claimed (now() - created_at).
   * The dead-letter bound reads this, never the host clock (the Time rule, .github#29).
   */
  waitedMs: number;
}

/**
 * Performs Graph work the API asked for. WORKER ONLY. Two concrete relays share this body and differ
 * only in WHICH KINDS they claim, so that no account task is ever batched with, or serialized behind, a
 * scan:
 *
 *   {@link GraphAccountRelayService}   account reconciles: seconds each, a 150 s lease, batches of 3
 *   {@link GraphScanRelayService}      scans and syncs: minutes each, a long lease, one at a time
 *
 * Each is its own claim and its own in-flight pass, so an offboarding disable runs while a scan is still
 * in progress, and a worker that crashes holding a scan strands that scan alone.
 *
 * LEASED, NOT LOCKED (see AbstractOutboxRelay). The Graph call happens with no transaction open. The
 * lease of each kind is derived from its call budget and the per-request deadline (graph-task.ts), so it
 * always outlives the calls it covers.
 *
 * ORDERED PER KEY. A row is claimable only while no OTHER row with its ordering key is either earlier
 * and pending (running, backing off, or just not finished) or holding a live lease — the second clause
 * covers commit order differing from `seq` order.
 *
 * CLAIMS ARE SERIALIZED. Under READ COMMITTED each statement takes a fresh snapshot, so two claim
 * transactions running at once cannot see each other's not-yet-committed leases. Each claim therefore
 * takes `pg_advisory_xact_lock` in a statement BEFORE its SELECT and holds it until it commits (which is
 * when its leases become visible): a second claimer waits, and its SELECT — a new statement, a new
 * snapshot — sees the first one's leases. The lock is short (a claim is a few milliseconds) and covers
 * the whole Graph outbox, both relays.
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

  /** Serialize claims (see the class comment). Waits for any claim in flight; released at commit. */
  protected override async beforeSelect(tx: DrizzleTx): Promise<void> {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('messaging.graph_task_outbox:claim'))`,
    );
  }

  /** Only this relay's own kinds: the other relay's abandoned rows are its to dead-letter, and to name. */
  protected override reapFilter() {
    return inArray(graphTaskOutbox.kind, [...this.kinds]);
  }

  protected override reapLabel(): string {
    return `${this.queueName}[${this.kinds.join(',')}]`;
  }

  protected async selectDue(tx: DrizzleTx, limit: number, now: SQL): Promise<TaskRow[]> {
    if (!this.graph.isEnabled()) return [];
    const rows = await tx
      .select({
        id: graphTaskOutbox.id,
        kind: graphTaskOutbox.kind,
        payload: graphTaskOutbox.payload,
        attempts: graphTaskOutbox.attempts,
        createdAt: graphTaskOutbox.createdAt,
        waitedMs: sql<
          number | string
        >`extract(epoch from (${DB_NOW} - ${graphTaskOutbox.createdAt})) * 1000`,
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
                    OR (other.lease_token IS NOT NULL AND other.locked_until > ${now}))
          ))`,
        ),
      )
      .orderBy(asc(graphTaskOutbox.seq), asc(graphTaskOutbox.id))
      .limit(limit)
      .for('update', { skipLocked: true });
    return rows.map((r) => ({ ...r, waitedMs: Number(r.waitedMs) }));
  }

  protected async deliver(row: Claimed<TaskRow>): Promise<void> {
    try {
      switch (row.kind) {
        case GRAPH_TASK.ACCOUNT_RECONCILE:
          return await this.accounts.reconcile(employeeId(row.payload), row.leaseExpiresAt);
        case GRAPH_TASK.SHADOW_IT_SCAN:
          return await this.exclusively(GRAPH_LOCK.SHADOW_IT, row, async () => {
            await this.scan.detectShadowIt();
          });
        case GRAPH_TASK.POSTURE_SYNC:
          return await this.exclusively(GRAPH_LOCK.POSTURE, row, async () => {
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
   *
   * BOUNDED. A refunded attempt is not a retry budget, so deferral needs its own limit or a lock that
   * never frees would defer for ever. A lock lasts at most its TTL; a request that has been waiting
   * longer than the TTL plus a margin has outlived any run that could still legitimately hold it, so
   * something is wrong (a run that keeps renewing it, a TTL that is too long) and an operator needs to
   * know: dead-letter, which raises the alarm.
   */
  private async exclusively(
    lock: { name: string; ttlMs: number },
    row: Claimed<TaskRow>,
    work: () => Promise<void>,
  ): Promise<void> {
    let ran = false;
    await this.exclusive.run(lock.name, lock.ttlMs, async () => {
      ran = true;
      await work();
    });
    if (ran) return;

    if (row.waitedMs > lock.ttlMs + LOCK_WAIT_MARGIN_MS) {
      throw new NonRetryableError(
        `${lock.name} stayed held for ${Math.round(row.waitedMs / 60_000)} min, longer than its ` +
          `${Math.round(lock.ttlMs / 60_000)} min TTL: giving up on this request`,
      );
    }
    throw new DeferError(`${lock.name} is held by another run`, LOCK_HELD_DELAY_MS);
  }

  protected async markSent(tx: DrizzleTx, row: Claimed<TaskRow>): Promise<void> {
    await tx
      .update(graphTaskOutbox)
      .set({ status: 'sent', sentAt: DB_NOW, lastError: null })
      .where(eq(graphTaskOutbox.id, row.id));
  }

  protected async markFailed(
    tx: DrizzleTx,
    row: Claimed<TaskRow>,
    newStatus: 'pending' | 'failed',
    error: string,
    delayMs: number,
  ): Promise<void> {
    await tx
      .update(graphTaskOutbox)
      .set({
        status: newStatus,
        lastError: error.slice(0, MAX_ERROR_LENGTH),
        nextAttemptAt: dbDelay(delayMs),
      })
      .where(eq(graphTaskOutbox.id, row.id));
  }
}

/** Account tasks: an offboarding disable must never wait behind a scan. */
@Injectable()
export class GraphAccountRelayService extends GraphTaskRelay {
  protected readonly kinds = [GRAPH_TASK.ACCOUNT_RECONCILE];
  override get wakeKind(): string {
    return GRAPH_WAKE.ACCOUNT;
  }
  /** Held for the SUM of the batch's leases (150 s each): 3 rows is 7.5 minutes if a worker dies. */
  protected override readonly batchSize = 3;

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
  override get wakeKind(): string {
    return GRAPH_WAKE.SCAN;
  }
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
