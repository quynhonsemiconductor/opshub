/**
 * AbstractOutboxRelay — generic base class for all transactional outbox relay services.
 *
 * Encapsulates the polling machinery that is identical across every outbox-style
 * relay (email, notifications, webhooks, push, …):
 *   - Concurrency guard (isRelaying)
 *   - SELECT … FOR UPDATE SKIP LOCKED inside a DB transaction
 *   - Per-row try/catch with attempt counter and status update
 *   - Post-commit task execution (Valkey pub/sub publishes, etc.)
 *
 * Subclasses provide only domain-specific behaviour:
 *   - fetchBatch()   → SELECT from their specific outbox table
 *   - processRow()   → send email / dispatch notification / fire webhook / …
 *   - markSent()     → UPDATE row status to 'sent'
 *   - markFailed()   → UPDATE row status + attempts + last_error
 *
 * Post-commit tasks:
 *   processRow() may return a PostCommitTask (() => Promise<void>).
 *   The base class runs it AFTER the transaction commits so downstream consumers
 *   (SSE, push channels) never receive an event before the DB write is durable.
 *   Returning undefined/void means no post-commit work.
 *
 * Adding a new relay (e.g., webhook delivery):
 *   1. Create a DB outbox table and Drizzle schema entry.
 *   2. Extend AbstractOutboxRelay<WebhookRow>.
 *   3. Implement the 4 abstract methods.
 *   4. Decorate the relay() override with @Cron + @Span.
 *   5. Register the class as a provider in the module.
 */
import { Logger } from '@nestjs/common';
import { QueueMetrics, withJobContext } from '@qnsc-vn/observability';
import type { DrizzleDB, DrizzleTx } from '../database/drizzle.provider';

/** Optional callback returned by processRow() to run after the transaction commits. */
export type PostCommitTask = () => Promise<void>;

/**
 * Log field marking a row that has exhausted `maxAttempts` and will never be retried.
 *
 * A dead-lettered row is silent work loss: an email nobody receives, a notification
 * nobody sees, an outbox event that never reaches its consumer. The row records it,
 * but only for someone who thinks to query `status = 'failed'` — so in practice the
 * queue stops doing its job and the first symptom is a user asking why.
 *
 * A distinct field rather than a distinguishable message, because a CloudWatch metric
 * filter matches structured fields, and pattern-matching on prose breaks the day
 * someone rewords a log line.
 *
 * `aws_cloudwatch_log_metric_filter.outbox_dead_letter` in infra/modules/stack matches
 * this exact field on the WORKER's log group, and its alarm notifies the observability
 * topic. `abstract-outbox-relay.spec.ts` greps the Terraform to prove the two still agree —
 * renaming this constant without editing the filter would otherwise leave an alarm that can
 * never fire, which is worse than no alarm because it reads as coverage.
 */
export const DEAD_LETTER_FIELD = 'outboxDeadLetter';

export abstract class AbstractOutboxRelay<TRow extends { id: string; attempts: number }> {
  /** Override in subclass to tune per-relay. */
  protected readonly maxAttempts: number = 5;
  protected readonly batchSize: number = 50;

  protected readonly logger: Logger;
  /** The currently in-flight pass, or null when idle. */
  private inFlight: Promise<void> | null = null;
  /**
   * A pass queued to start once `inFlight` finishes, shared by every caller that arrived
   * while busy — set only once per in-flight pass, so a burst of N racing calls coalesces
   * into exactly one extra pass rather than N.
   */
  private queued: Promise<void> | null = null;

  /**
   * Constructed directly rather than injected. DI would mean adding a parameter to all four
   * subclass constructors, and a fifth relay added later would silently emit nothing. The
   * instruments are process-global (OTel returns the same instrument for the same name) and
   * QueueMetrics has no dependencies, so there is nothing for DI to provide.
   */
  private readonly queueMetrics = new QueueMetrics();

  /** Metric label for this relay. Bounded: one value per relay subclass. */
  protected get queueName(): string {
    return this.constructor.name;
  }

  constructor(protected readonly db: DrizzleDB) {
    // Logger name is the concrete subclass name for precise log attribution.
    this.logger = new Logger(this.constructor.name);
  }

  // ── Abstract interface ────────────────────────────────────────────────────

  /**
   * SELECT a locked batch of pending rows from the outbox table.
   * MUST use the provided transaction and include FOR UPDATE SKIP LOCKED.
   */
  protected abstract fetchBatch(tx: DrizzleTx): Promise<TRow[]>;

  /**
   * Process one row — the domain-specific side effect (send email, fire webhook…).
   *
   * `tx` IS THE RELAY'S OWN TRANSACTION, the same one `markSent` writes into. An implementation that
   * enqueues follow-on work — one outbox feeding another — must use it, so the enqueue and this row's
   * `sent` transition commit together or not at all. Doing that write on a separate handle, or in the
   * post-commit task below, turns the chain into a dual write: the row is marked done, the follow-on
   * work is lost, and nothing retries because there is no longer anything pending.
   *
   * The sibling repo schedules its notification email in the post-commit task for exactly this reason
   * and has exactly that hole; the argument is here so this one does not.
   *
   * May return a PostCommitTask: a callback that runs AFTER the surrounding DB transaction commits.
   * That is for side effects OUTSIDE the database which must not fire before the write is durable —
   * a Valkey publish, an SSE push. Never for a database write.
   *
   * Return undefined/void when there is no post-commit work.
   */
  protected abstract processRow(row: TRow, tx: DrizzleTx): Promise<PostCommitTask | void>;

  /** Mark the row as successfully processed (within the relay transaction). */
  protected abstract markSent(tx: DrizzleTx, rowId: string): Promise<void>;

  /**
   * Mark the row as failed or pending-retry (within the relay transaction).
   * newStatus is 'failed' when newAttempts >= maxAttempts, otherwise 'pending'.
   */
  protected abstract markFailed(
    tx: DrizzleTx,
    rowId: string,
    newAttempts: number,
    newStatus: 'pending' | 'failed',
    lastError: string,
    /**
     * When the row becomes eligible again, from `backoffDelayMs`. A relay whose table has a
     * delay column (`scheduled_at`, `next_attempt_at`) MUST write it, or the row is re-read
     * on the very next tick and the whole retry budget burns in seconds. A relay whose table
     * has no such column names the parameter `_nextAttemptAt` and ignores it.
     */
    nextAttemptAt: Date,
  ): Promise<void>;

  /**
   * Exponential backoff with a cap, so a persistently-failing row is retried with
   * increasing spacing instead of burning all `maxAttempts` within seconds (bounded only by
   * the 5s cron cadence). Base 30s, doubling: attempt 1 → 30s, 2 → 1m, 3 → 2m, 4 → 4m,
   * 5 → 8m, capped at 30 minutes.
   *
   * Ported from rally, and it matters more than it looks: without it a 30-second dependency
   * outage destroys an email or notification permanently, because five immediate retries fit
   * inside the outage and the fifth dead-letters the row. Override per relay only for a
   * genuinely different curve — webhook deliveries do exactly that.
   */
  protected backoffDelayMs(newAttempts: number): number {
    const baseMs = 30_000;
    const capMs = 30 * 60_000;
    return Math.min(baseMs * 2 ** (newAttempts - 1), capMs);
  }

  // ── Relay loop ────────────────────────────────────────────────────────────

  /**
   * Core relay loop — called by the subclass @Cron handler (and optionally by
   * pub/sub wake signals for near-zero latency dispatch).
   *
   * Subclasses MUST override relay() and add @Cron + @Span decorators for a
   * unique cron name and trace span:
   *
   *   @Cron('*\/5 * * * * *', { name: 'my-relay' })
   *   @Span('my.relay')
   *   override async relay(): Promise<void> { return super.relay(); }
   */
  async relay(): Promise<void> {
    if (this.inFlight) {
      // A pass is already running. Coalesce with whatever is already queued behind it (or
      // start queuing one) so a burst of N racing calls shares exactly one extra pass — but
      // every caller still awaits a pass that STARTS AFTER their own call, never the one
      // already in flight. The previous design set a boolean and returned immediately, so a
      // racing caller's promise resolved before any corresponding fetchBatch had run: fine
      // for the cron, a footgun for a test that awaits relay() and asserts on the row it
      // just inserted.
      this.queued ??= this.inFlight.then(() => this.runOnce());
      return this.queued;
    }
    this.inFlight = this.runOnce();
    return this.inFlight;
  }

  /**
   * Runs exactly one fetch-process-mark pass, then hands off to any queued pass.
   *
   * Wrapped in a job context so every log line the pass emits — including from the services
   * it calls — carries a `correlationId`. Without it relay work logs with no context at all
   * and cannot be tied to the request that queued the row. Done here rather than per
   * subclass so all four relays inherit it.
   */
  private runOnce(): Promise<void> {
    return withJobContext(this.constructor.name, () => this.runOncePass()) as Promise<void>;
  }

  private async runOncePass(): Promise<void> {
    // Collected outside the transaction so they run only after it durably commits.
    const postCommitTasks: PostCommitTask[] = [];

    try {
      await this.db.transaction(async (tx) => {
        const batch = await this.fetchBatch(tx);
        if (!batch.length) return;

        this.logger.debug(`Relaying ${batch.length} row(s)`);

        // Backlog AGE, not just throughput: a relay falling behind looks perfectly healthy
        // on a processed-count graph while its queue grows.
        const oldest = batch.reduce<Date | undefined>((acc, candidate) => {
          const createdAt = (candidate as { createdAt?: Date }).createdAt;
          if (!createdAt) return acc;
          return !acc || createdAt < acc ? createdAt : acc;
        }, undefined);
        if (oldest) {
          this.queueMetrics.recordLag(this.queueName, (Date.now() - oldest.getTime()) / 1000);
        }

        let processed = 0;
        let failed = 0;

        for (const row of batch) {
          try {
            /*
             * A SAVEPOINT PER ROW, and the reason is not tidiness — it is that the `catch` below
             * could not do its job without one.
             *
             * The whole batch runs in one transaction. When a row failed for a DATABASE reason,
             * Postgres had already marked that transaction aborted, so the very first statement in
             * the catch — `markFailed` — failed too, with "current transaction is aborted, commands
             * ignored until end of transaction block". That error escaped the catch, propagated out
             * of the transaction callback, and rolled back the ENTIRE batch: every row that had
             * already been processed and marked sent went back, and the failing row's attempt
             * counter went back with them.
             *
             * So the queue stalled permanently. The next poll fetched the same batch, hit the same
             * poison row, and rolled everything back again — and because the attempt counter never
             * survived, the row never reached `maxAttempts` and never dead-lettered. One malformed
             * notification was enough to stop every email behind it, indefinitely, with the dead
             * letter alarm silent because nothing was ever marked failed.
             *
             * `tx.transaction()` on Postgres issues a SAVEPOINT. A database error inside now rolls
             * back to here, which leaves the outer transaction usable — which is exactly what the
             * catch needs.
             */
            const task = await tx.transaction(async (rowTx) => {
              const result = await this.processRow(row, rowTx);
              await this.markSent(rowTx, row.id);
              return result;
            });
            if (task) postCommitTasks.push(task);
            processed += 1;
          } catch (err) {
            failed += 1;
            const errMsg = err instanceof Error ? err.message : String(err);
            const newAttempts = row.attempts + 1;
            const newStatus: 'pending' | 'failed' =
              newAttempts >= this.maxAttempts ? 'failed' : 'pending';
            const nextAttemptAt = new Date(Date.now() + this.backoffDelayMs(newAttempts));

            /*
             * Also in its own savepoint. If recording the failure itself fails — the row deleted
             * under us, a constraint on the error text — the batch must still finish rather than
             * lose the rows that succeeded. Logged rather than rethrown for the same reason: the
             * whole point of this loop is that one row cannot take the others with it.
             */
            try {
              await tx.transaction(async (failTx) => {
                await this.markFailed(
                  failTx,
                  row.id,
                  newAttempts,
                  newStatus,
                  errMsg,
                  nextAttemptAt,
                );
              });
            } catch (markErr) {
              this.logger.error(
                { rowId: row.id, err: markErr },
                'Relay could not record a row failure — the row will be retried on the next poll',
              );
            }

            // Only the TERMINAL failure carries DEAD_LETTER_FIELD. A row still inside its
            // retry budget is the retry machinery working as designed; tagging every attempt
            // would make the alarm fire on transient errors that resolve themselves.
            if (newStatus === 'failed') {
              this.logger.error(
                { rowId: row.id, err, [DEAD_LETTER_FIELD]: this.queueName },
                `Relay dead-lettered a row after ${newAttempts}/${this.maxAttempts} attempts — it will never be retried`,
              );
            } else {
              this.logger.error(
                { rowId: row.id, err },
                `Relay failed (attempt ${newAttempts}/${this.maxAttempts})`,
              );
            }
          }
        }

        this.queueMetrics.recordProcessed(this.queueName, processed);
        this.queueMetrics.recordFailure(this.queueName, failed);
      });

      // Committed — post-commit tasks are fire-and-forget. A failure here cannot affect
      // outbox correctness; the row is already marked sent.
      for (const task of postCommitTasks) {
        task().catch((err: unknown) => this.logger.error({ err }, 'Post-commit task failed'));
      }
    } finally {
      // Hand off to the queued pass BEFORE clearing inFlight, so a caller arriving in the gap
      // between this pass finishing and the queued one starting still sees a truthy inFlight
      // and coalesces onto it instead of racing to start a third. `next` is already running
      // (created via .then() in relay()); the .catch() only prevents an unhandled rejection
      // when the queuer fired and forgot, as the cron does.
      const next = this.queued;
      this.queued = null;
      this.inFlight = next;
      next?.catch((err: unknown) => this.logger.error({ err }, 'Queued relay pass failed'));
    }
  }
}
