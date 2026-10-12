/**
 * AbstractOutboxRelay — the shared relay for every transactional outbox (email, notifications,
 * webhooks, Graph tasks).
 *
 * LEASE AND FENCE, NOT ONE LONG TRANSACTION
 *
 * The relay used to open one transaction, `SELECT … FOR UPDATE SKIP LOCKED` a batch, call the external
 * system for every row inside it, and commit at the end. The external call is the slow, unreliable
 * part, so the transaction (and its row locks) stayed open for as long as it took. The runtime role has
 * `idle_in_transaction_session_timeout`; a call that outlasted it had its SESSION killed, which rolled
 * back the whole batch AND the attempt counters — so the row never reached `maxAttempts`, never
 * dead-lettered, and the loop repeated forever with nothing in the logs.
 *
 * A pass is now three steps, and no transaction is open during the middle one:
 *
 *   1. CLAIM  (short transaction) — select the due rows `FOR UPDATE SKIP LOCKED`, and stamp each with
 *             `attempts = attempts + 1`, a fresh `lease_token` and `locked_until = now() + lease`.
 *             Commit. The attempt is spent at claim time, so a process that dies mid-call still uses up
 *             its budget instead of looping.
 *   2. DELIVER (no transaction) — `deliver(row)` does the external work.
 *   3. FINISH (new short transaction) — `WHERE id = $1 AND lease_token = $2` re-locks the row; if no row
 *             matches, the lease was lost (it lapsed and another relay took the row): log it and write
 *             nothing. Otherwise `settle` + `markSent`, or `markFailed`, and the lease is cleared.
 *
 * A row whose lease lapsed with the attempts used up is dead-lettered by the next claim
 * ("abandoned"), so nothing sits `pending` forever.
 *
 * What a subclass provides:
 *   - `outbox`     the table and its lease columns
 *   - `selectDue`  the due rows, `FOR UPDATE SKIP LOCKED`, NOT currently leased ({@link notLeased}),
 *                  ordered by `seq`
 *   - `deliver`    the external call. NO transaction is open: do not touch the database through the
 *                  relay's handle. Throw {@link NonRetryableError} to dead-letter at once,
 *                  {@link RetryAfterError} to honour a server's Retry-After.
 *   - `settle`     optional database writes that must commit atomically with the row going to sent (a
 *                  follow-on outbox row, an in-app notification). Runs inside the fenced finish
 *                  transaction and may return a post-commit task.
 *   - `markSent` / `markFailed`  the status writes, inside the same fenced transaction.
 *
 * Post-commit tasks: `settle` may return a PostCommitTask. The base class runs it AFTER the finish
 * transaction commits so downstream consumers (SSE, push channels) never see an event before the
 * database write is durable.
 *
 * Adding a relay: a table with the `outboxLease()` columns, extend this, implement the abstract
 * members, decorate `relay()` with @Cron + @Span, register the class as a provider.
 */
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { QueueMetrics, withJobContext } from '@quynhonsemiconductor/observability';
import { and, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { DrizzleDB, DrizzleTx } from '../database/drizzle.provider';

/** Optional callback returned by settle() to run after the finish transaction commits. */
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

/** A failure that retrying cannot fix (a 400, 403 or 404): dead-letter the row now, not after five tries. */
export class NonRetryableError extends Error {
  override readonly name = 'NonRetryableError';
}

/** A failure the server told us how long to wait out (HTTP 429/503 Retry-After). */
export class RetryAfterError extends Error {
  override readonly name = 'RetryAfterError';
  constructor(
    message: string,
    readonly retryAfterMs: number,
  ) {
    super(message);
  }
}

/**
 * "Not now, and this was not an attempt": the row goes back to pending after `delayMs` and the attempt the
 * claim spent is REFUNDED. For a precondition outside the row's control (a lock another run holds), where
 * counting attempts would dead-letter work that never got a chance to run.
 */
export class DeferError extends Error {
  override readonly name = 'DeferError';
  constructor(
    message: string,
    readonly delayMs: number,
  ) {
    super(message);
  }
}

/**
 * The longest a server-supplied Retry-After is honoured. A hostile or buggy value (1e13 seconds) must
 * neither park a row for ever nor become an Invalid Date that makes `markFailed` throw. With per-key
 * ordering, one huge hint would also hold back every later task for that key.
 */
export const MAX_RETRY_AFTER_MS = 60 * 60_000;

/** The table a relay works on and the columns the base class needs to lease, fence and dead-letter it. */
export interface OutboxLeaseTable {
  table: PgTable;
  id: AnyPgColumn;
  status: AnyPgColumn;
  attempts: AnyPgColumn;
  lastError: AnyPgColumn;
  leaseToken: AnyPgColumn;
  lockedUntil: AnyPgColumn;
  seq: AnyPgColumn;
}

/** The row as the claim step hands it to the relay: `attempts` includes this attempt. */
export type Claimed<TRow> = TRow & {
  leaseToken: string;
  /**
   * When this relay's lease on the row lapses, as of the last renewal. A delivery that is about to make
   * a call it cannot take back (a mutation) must check that enough of the lease remains for the call to
   * finish — see {@link remainingLeaseMs}.
   */
  leaseExpiresAt: Date;
};

/** Milliseconds of this row's lease still ahead of `now`. */
export function remainingLeaseMs(row: { leaseExpiresAt: Date }, now: number = Date.now()): number {
  return row.leaseExpiresAt.getTime() - now;
}

const DEFAULT_LEASE_MS = 2 * 60_000;

/** A pass drains at most this many batches before yielding to the next tick. */
export const MAX_BATCHES_PER_PASS = 50;

export abstract class AbstractOutboxRelay<
  TRow extends { id: string; attempts: number },
  TResult = void,
> {
  /** Override in subclass to tune per-relay. */
  protected readonly maxAttempts: number = 5;
  /**
   * Rows per claim. SMALL on purpose: a claim holds every row of the batch for the SUM of their leases
   * (they are worked one after another), so a worker that dies holding a batch strands it for that long.
   * A pass keeps claiming until the queue is empty (up to {@link MAX_BATCHES_PER_PASS}), so a small batch
   * costs no throughput.
   */
  protected readonly batchSize: number = 10;

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
   * Constructed directly rather than injected. DI would mean adding a parameter to every subclass
   * constructor, and a new relay added later would silently emit nothing. The instruments are
   * process-global (OTel returns the same instrument for the same name) and QueueMetrics has no
   * dependencies, so there is nothing for DI to provide.
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

  protected abstract readonly outbox: OutboxLeaseTable;

  /**
   * SELECT the due rows. MUST use the provided transaction, `FOR UPDATE SKIP LOCKED`, exclude rows
   * that are currently leased ({@link notLeased}), and order by `seq`.
   */
  protected abstract selectDue(tx: DrizzleTx, limit: number, now: Date): Promise<TRow[]>;

  /**
   * The external side effect. NO transaction is open. Returns whatever `settle` / `markSent` need (a
   * provider message id). Throw to fail the row; see {@link NonRetryableError}, {@link RetryAfterError}.
   */
  protected abstract deliver(row: Claimed<TRow>): Promise<TResult>;

  /**
   * Database writes that must commit atomically with the row going to `sent` — a follow-on outbox row,
   * an in-app notification. Runs in the fenced finish transaction `tx`; the same transaction `markSent`
   * writes into, so the follow-on work and this row's transition commit together or not at all. Doing
   * that write on another handle turns the chain into a dual write.
   *
   * May return a PostCommitTask for side effects OUTSIDE the database that must not fire before the
   * write is durable (a Valkey publish, an SSE push). Never for a database write.
   */
  protected settle(
    _row: Claimed<TRow>,
    _result: TResult,
    _tx: DrizzleTx,
  ): Promise<PostCommitTask | void> {
    return Promise.resolve();
  }

  /** Mark the row as successfully processed (inside the fenced transaction). */
  protected abstract markSent(tx: DrizzleTx, row: Claimed<TRow>, result: TResult): Promise<void>;

  /**
   * Mark the row failed or pending-retry (inside the fenced transaction). `row.attempts` already counts
   * this attempt. `newStatus` is 'failed' when attempts are exhausted or the error was not retryable.
   */
  protected abstract markFailed(
    tx: DrizzleTx,
    row: Claimed<TRow>,
    newStatus: 'pending' | 'failed',
    lastError: string,
    /**
     * When the row becomes eligible again. A relay whose table has a delay column (`scheduled_at`,
     * `next_attempt_at`) MUST write it, or the row is re-read on the very next tick and the whole retry
     * budget burns in seconds. A relay with its own curve names the parameter `_nextAttemptAt`.
     */
    nextAttemptAt: Date,
  ): Promise<void>;

  /** How long a claimed row is hidden from other relays. Must exceed the longest `deliver` for the row. */
  protected leaseMsFor(_row: TRow): number {
    return DEFAULT_LEASE_MS;
  }

  /**
   * Exponential backoff with a cap, so a persistently-failing row is retried with increasing spacing
   * instead of burning all `maxAttempts` within seconds. Base 30s, doubling: attempt 1 → 30s, 2 → 1m,
   * 3 → 2m, 4 → 4m, 5 → 8m, capped at 30 minutes. Without it a 30-second dependency outage destroys an
   * email or notification permanently. Override per relay only for a genuinely different curve.
   */
  protected backoffDelayMs(newAttempts: number): number {
    const baseMs = 30_000;
    const capMs = 30 * 60_000;
    return Math.min(baseMs * 2 ** (newAttempts - 1), capMs);
  }

  /**
   * Restricts the abandoned-row reaper to THIS relay's own rows. A table shared by two relays (the Graph
   * outbox: account tasks and scans) would otherwise be reaped by whichever relay claims first, and the
   * dead-letter alarm would name the wrong one.
   */
  protected reapFilter(): SQL | undefined {
    return undefined;
  }

  /** The label the dead-letter alarm carries for rows this relay abandons. */
  protected reapLabel(): string {
    return this.queueName;
  }

  /**
   * Runs inside the claim transaction BEFORE the claim SELECT. A relay that must serialize concurrent
   * claims takes a transaction-scoped advisory lock here: under READ COMMITTED every statement takes a
   * fresh snapshot, so a SELECT that runs after the lock is acquired sees every lease the previous holder
   * stamped and committed.
   */
  protected beforeSelect(_tx: DrizzleTx): Promise<void> {
    return Promise.resolve();
  }

  /** `lease is absent or has lapsed` — put this in every `selectDue` WHERE clause. */
  protected notLeased(now: Date) {
    return or(isNull(this.outbox.lockedUntil), lte(this.outbox.lockedUntil, now));
  }

  // ── Database steps (isolated so tests can replace them) ───────────────────

  /** Dead-letter rows whose attempts are spent and whose lease has lapsed: they were abandoned mid-call. */
  protected async reapAbandoned(tx: DrizzleTx, now: Date): Promise<number> {
    const o = this.outbox;
    const own = this.reapFilter();
    const reaped = await tx
      .update(o.table)
      .set({
        status: 'failed',
        lastError: sql`'abandoned: the lease lapsed with every attempt used (the process died or the call never returned)'`,
        leaseToken: null,
        lockedUntil: null,
      })
      .where(
        and(
          sql`${o.status} = 'pending'`,
          sql`${o.attempts} >= ${this.maxAttempts}`,
          or(isNull(o.lockedUntil), lte(o.lockedUntil, now)),
          ...(own ? [own] : []),
        ),
      )
      .returning({ id: o.id } as never);
    return (reaped as unknown[]).length;
  }

  /** Stamp the rows with a lease and spend an attempt on each. Returns the new attempt counts. */
  protected async stampLeases(
    tx: DrizzleTx,
    ids: string[],
    token: string,
    lockedUntil: Date,
  ): Promise<Map<string, number>> {
    const o = this.outbox;
    const rows = (await tx
      .update(o.table)
      .set({ attempts: sql`${o.attempts} + 1`, leaseToken: token, lockedUntil })
      .where(inArray(o.id, ids))
      .returning({ id: o.id, attempts: o.attempts } as never)) as Array<{
      id: string;
      attempts: number;
    }>;
    return new Map(rows.map((r) => [r.id, r.attempts]));
  }

  /** Re-lock the row iff this relay still holds the lease. The fence. */
  protected async holdsLease(tx: DrizzleTx, row: Claimed<TRow>): Promise<boolean> {
    const o = this.outbox;
    const held = await tx
      .select({ id: o.id } as never)
      .from(o.table)
      .where(and(sql`${o.id} = ${row.id}`, sql`${o.leaseToken} = ${row.leaseToken}`))
      .for('update');
    return (held as unknown[]).length > 0;
  }

  /**
   * Push the lease out before delivering: rows late in a batch have been waiting behind earlier ones.
   * Resolves to the new expiry, or `null` if the lease was lost.
   */
  protected async renewLease(row: Claimed<TRow>): Promise<Date | null> {
    const o = this.outbox;
    const expiresAt = new Date(Date.now() + this.leaseMsFor(row));
    const renewed = await this.db
      .update(o.table)
      .set({ lockedUntil: expiresAt })
      .where(and(sql`${o.id} = ${row.id}`, sql`${o.leaseToken} = ${row.leaseToken}`))
      .returning({ id: o.id } as never);
    return (renewed as unknown[]).length > 0 ? expiresAt : null;
  }

  /** Give back the attempt the claim spent (see {@link DeferError}). */
  protected async refundAttempt(tx: DrizzleTx, row: Claimed<TRow>): Promise<void> {
    const o = this.outbox;
    await tx
      .update(o.table)
      .set({ attempts: sql`GREATEST(${o.attempts} - 1, 0)` })
      .where(sql`${o.id} = ${row.id}`);
  }

  protected async releaseLease(tx: DrizzleTx, row: Claimed<TRow>): Promise<void> {
    const o = this.outbox;
    await tx
      .update(o.table)
      .set({ leaseToken: null, lockedUntil: null })
      .where(sql`${o.id} = ${row.id}`);
  }

  // ── Relay loop ────────────────────────────────────────────────────────────

  /**
   * Core relay loop — called by the subclass @Cron handler (and optionally by pub/sub wake signals for
   * near-zero latency dispatch).
   *
   * Subclasses MUST override relay() and add @Cron + @Span decorators for a unique cron name and trace
   * span:
   *
   *   @Cron('*\/5 * * * * *', { name: 'my-relay' })
   *   @Span('my.relay')
   *   override async relay(): Promise<void> { return super.relay(); }
   */
  async relay(): Promise<void> {
    if (this.inFlight) {
      // A pass is already running. Coalesce with whatever is already queued behind it (or start
      // queuing one) so a burst of N racing calls shares exactly one extra pass — but every caller still
      // awaits a pass that STARTS AFTER their own call, never the one already in flight.
      this.queued ??= this.inFlight.then(() => this.runOnce());
      return this.queued;
    }
    this.inFlight = this.runOnce();
    return this.inFlight;
  }

  /**
   * Runs exactly one claim-deliver-finish pass, then hands off to any queued pass.
   *
   * Wrapped in a job context so every log line the pass emits — including from the services it calls —
   * carries a `correlationId`.
   */
  private runOnce(): Promise<void> {
    return withJobContext(this.constructor.name, () => this.runOncePass()) as Promise<void>;
  }

  private async claim(): Promise<Array<Claimed<TRow>>> {
    return this.db.transaction(async (tx) => {
      const abandoned = await this.reapAbandoned(tx, new Date());
      if (abandoned > 0) {
        this.logger.error(
          { abandoned, [DEAD_LETTER_FIELD]: this.reapLabel() },
          `Relay dead-lettered ${abandoned} abandoned row(s): the lease lapsed with every attempt used`,
        );
      }

      await this.beforeSelect(tx);
      // `now` is taken AFTER beforeSelect: a relay that serializes its claims may have waited for the lock,
      // and a hold measured from before the wait would be shortened by it.
      const now = new Date();
      const rows = await this.selectDue(tx, this.batchSize, now);
      if (!rows.length) return [];

      // Backlog AGE, not just throughput: a relay falling behind looks perfectly healthy on a
      // processed-count graph while its queue grows.
      const oldest = rows.reduce<Date | undefined>((acc, candidate) => {
        const createdAt = (candidate as { createdAt?: Date }).createdAt;
        if (!createdAt) return acc;
        return !acc || createdAt < acc ? createdAt : acc;
      }, undefined);
      if (oldest) {
        this.queueMetrics.recordLag(this.queueName, (Date.now() - oldest.getTime()) / 1000);
      }

      // One token per claim. The rows are worked ONE AFTER ANOTHER, so the batch is held for the SUM of
      // their leases: a row late in the batch waits behind earlier ones, and a hold shorter than that
      // would let its lease lapse while it waited, so another relay re-claims it and an attempt is
      // burned. (A single lease, or the longest one, was not enough.) Each row renews its own lease
      // right before it is delivered, so the hold only has to cover the waiting.
      const token = randomUUID();
      const holdMs = rows.reduce((total, r) => total + this.leaseMsFor(r), 0);
      const leaseExpiresAt = new Date(now.getTime() + holdMs);
      const attempts = await this.stampLeases(
        tx,
        rows.map((r) => r.id),
        token,
        leaseExpiresAt,
      );
      return rows.map((r) => ({
        ...r,
        attempts: attempts.get(r.id) ?? r.attempts + 1,
        leaseToken: token,
        leaseExpiresAt,
      }));
    });
  }

  private async runOncePass(): Promise<void> {
    try {
      let processed = 0;
      let failed = 0;
      // Keep claiming until the queue is empty: batches are small (see batchSize), so one pass drains
      // as much as one big batch would, and a crash strands only the batch in hand.
      for (let i = 0; i < MAX_BATCHES_PER_PASS; i += 1) {
        const batch = await this.claim();
        if (!batch.length) break;
        this.logger.debug(`Relaying ${batch.length} row(s)`);
        for (const row of batch) {
          const outcome = await this.handle(row);
          if (outcome === 'sent') processed += 1;
          else if (outcome === 'failed') failed += 1;
        }
      }
      this.queueMetrics.recordProcessed(this.queueName, processed);
      this.queueMetrics.recordFailure(this.queueName, failed);
    } finally {
      // Hand off to the queued pass BEFORE clearing inFlight, so a caller arriving in the gap between
      // this pass finishing and the queued one starting still sees a truthy inFlight and coalesces onto
      // it instead of racing to start a third. `next` is already running (created via .then() in
      // relay()); the .catch() only prevents an unhandled rejection when the queuer fired and forgot,
      // as the cron does.
      const next = this.queued;
      this.queued = null;
      this.inFlight = next;
      next?.catch((err: unknown) => this.logger.error({ err }, 'Queued relay pass failed'));
    }
  }

  /** One row, start to finish. Never throws: one row cannot take the others down with it. */
  private async handle(claimed: Claimed<TRow>): Promise<'sent' | 'failed' | 'lost' | 'deferred'> {
    let row = claimed;
    try {
      const expiresAt = await this.renewLease(claimed);
      if (!expiresAt) {
        this.logger.warn({ rowId: row.id }, 'Relay lost the lease before delivering — skipping');
        return 'lost';
      }
      row = { ...claimed, leaseExpiresAt: expiresAt };
    } catch (err) {
      this.logger.error({ rowId: row.id, err }, 'Relay could not renew a lease — skipping the row');
      return 'lost';
    }

    let result: TResult;
    try {
      result = await this.deliver(row);
    } catch (err) {
      return this.fail(row, err);
    }

    try {
      const task = await this.finish(row, async (tx) => {
        const post = await this.settle(row, result, tx);
        await this.markSent(tx, row, result);
        return post;
      });
      if (task === LEASE_LOST) return 'lost';
      if (task)
        task().catch((err: unknown) => this.logger.error({ err }, 'Post-commit task failed'));
      return 'sent';
    } catch (err) {
      // `settle` or the status write failed: nothing committed. The delivery DID happen, so the
      // failure is recorded for the retry budget rather than swallowed.
      return this.fail(row, err);
    }
  }

  /** The fenced finish transaction. Resolves to LEASE_LOST when another relay holds the row now. */
  private async finish(
    row: Claimed<TRow>,
    work: (tx: DrizzleTx) => Promise<PostCommitTask | void>,
  ): Promise<PostCommitTask | void | typeof LEASE_LOST> {
    return this.db.transaction(async (tx) => {
      if (!(await this.holdsLease(tx, row))) {
        this.logger.warn(
          { rowId: row.id },
          'Relay lost the lease before finishing — another relay holds this row now; writing nothing',
        );
        return LEASE_LOST;
      }
      const post = await work(tx);
      await this.releaseLease(tx, row);
      return post;
    });
  }

  /** Put the row back to pending after `delayMs`, refunding the attempt. */
  private async defer(row: Claimed<TRow>, err: DeferError): Promise<'deferred' | 'lost'> {
    const delayMs = Number.isFinite(err.delayMs)
      ? Math.min(Math.max(err.delayMs, 0), MAX_RETRY_AFTER_MS)
      : 5 * 60_000;
    const nextAttemptAt = new Date(Date.now() + delayMs);
    try {
      const done = await this.finish(row, async (tx) => {
        await this.refundAttempt(tx, row);
        await this.markFailed(
          tx,
          { ...row, attempts: Math.max(row.attempts - 1, 0) },
          'pending',
          err.message,
          nextAttemptAt,
        );
      });
      if (done === LEASE_LOST) return 'lost';
    } catch (markErr) {
      this.logger.error(
        { rowId: row.id, err: markErr },
        'Relay could not defer a row — the lease will lapse and it will be claimed again',
      );
    }
    this.logger.warn(
      { rowId: row.id },
      `Relay deferred a row for ${Math.round(delayMs / 1000)} s: ${err.message}`,
    );
    return 'deferred';
  }

  private async fail(row: Claimed<TRow>, err: unknown): Promise<'failed' | 'lost' | 'deferred'> {
    if (err instanceof DeferError) return this.defer(row, err);
    const errMsg = err instanceof Error ? err.message : String(err);
    const nonRetryable = err instanceof NonRetryableError;
    const newStatus: 'pending' | 'failed' =
      nonRetryable || row.attempts >= this.maxAttempts ? 'failed' : 'pending';
    // A hint is honoured up to a clamp and only if it is a real number: a non-finite or absurd value
    // falls back to ordinary backoff rather than producing an Invalid Date.
    const hinted =
      err instanceof RetryAfterError && Number.isFinite(err.retryAfterMs)
        ? Math.min(Math.max(err.retryAfterMs, 0), MAX_RETRY_AFTER_MS)
        : 0;
    const delayMs = Math.max(hinted, this.backoffDelayMs(row.attempts));
    const nextAttemptAt = new Date(Date.now() + delayMs);

    try {
      const recorded = await this.finish(row, (tx) =>
        this.markFailed(tx, row, newStatus, errMsg, nextAttemptAt),
      );
      if (recorded === LEASE_LOST) return 'lost';
    } catch (markErr) {
      // If recording the failure itself fails (database down) the lease lapses and the row is claimed
      // again with its attempt already spent — so the budget still runs out.
      this.logger.error(
        { rowId: row.id, err: markErr },
        'Relay could not record a row failure — the lease will lapse and the row will be retried',
      );
      return 'failed';
    }

    // Only the TERMINAL failure carries DEAD_LETTER_FIELD. A row still inside its retry budget is the
    // retry machinery working as designed; tagging every attempt would make the alarm fire on transient
    // errors that resolve themselves.
    if (newStatus === 'failed') {
      this.logger.error(
        { rowId: row.id, err, [DEAD_LETTER_FIELD]: this.queueName },
        `Relay dead-lettered a row after ${row.attempts}/${this.maxAttempts} attempts${nonRetryable ? ' (not retryable)' : ''} — it will never be retried`,
      );
    } else {
      this.logger.error(
        { rowId: row.id, err },
        `Relay failed (attempt ${row.attempts}/${this.maxAttempts})`,
      );
    }
    return 'failed';
  }
}

const LEASE_LOST = Symbol('lease-lost');
