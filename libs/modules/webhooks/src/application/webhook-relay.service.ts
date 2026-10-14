import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, lt, lte, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { Cron } from '@nestjs/schedule';
import { createHmac } from 'crypto';
import {
  AbstractOutboxRelay,
  AppConfigService,
  InjectDrizzle,
  Span,
  describeUnsafeResolvedTarget,
} from '@platform';
import type { Claimed, DrizzleDB, DrizzleTx, OutboxLeaseTable } from '@platform';
import { webhookDeliveries, webhookSubscriptions } from '../../../../../db/schema';
import { MS_PER_SEC } from '@shared-kernel';

const WEBHOOK_TIMEOUT_MS = 10_000; // 10s per delivery attempt
const RETRY_DELAYS_SECONDS = [60, 300, 900, 3600]; // 1m → 5m → 15m → 1h
const MAX_DELIVERY_ERROR_LENGTH = 2_000; // chars stored in lastError column
const MS_PER_HOUR = 3_600_000;
/** Rows expired per claim. The claim repeats (up to 50 per pass), so a large backlog clears over a few passes. */
const EXPIRE_PER_CLAIM = 500;

type DeliveryRow = {
  id: string;
  subscriptionId: string;
  eventType: string;
  payload: unknown;
  attempts: number;
  url: string;
  secret: string;
};

/**
 * WebhookRelayService — polls `webhook_deliveries` and fires HTTP POST requests
 * to subscriber URLs with HMAC-SHA256 signatures.
 *
 * Signature header: `X-OpsHub-Signature: sha256=<hex>`
 * Body: JSON `{ id, eventType, payload, timestamp }`
 * Recipients verify: `sha256(secret, body) === header value`
 */
@Injectable()
export class WebhookRelayService extends AbstractOutboxRelay<DeliveryRow> {
  constructor(
    @InjectDrizzle() db: DrizzleDB,
    private readonly config: AppConfigService,
  ) {
    super(db);
  }

  /** Whole hours a delivery may stay `pending` before it is expired instead of sent (WEBHOOK_DELIVERY_MAX_AGE_HOURS). */
  private get maxAgeHours(): number {
    return this.config.get('WEBHOOK_DELIVERY_MAX_AGE_HOURS');
  }

  /**
   * EXPIRY, inside the claim transaction, before the due rows are selected.
   *
   * A delivery still `pending` after WEBHOOK_DELIVERY_MAX_AGE_HOURS is not sent: it is marked `failed`
   * ("expired: pending longer than N h") and kept. The body a receiver gets carries the time of SENDING, so a
   * stale event is indistinguishable from a fresh one, and a relay that was down for a day would otherwise replay
   * that day to every subscriber the moment it recovered.
   *
   * RACE-FREE, by the same rules as a claim: the candidate rows are locked `FOR UPDATE SKIP LOCKED` in THIS
   * transaction (a row another transaction holds is skipped, not waited for), and a row whose lease is live is not
   * a candidate at all (a relay is delivering it; its finish is fenced by `lease_token`). The update clears
   * `lease_token`, so a relay whose lease had lapsed and that is still running cannot write `delivered` over
   * `failed`: its fence (`lease_token = ...`) no longer matches. No other relay can claim an expired row either,
   * because it is no longer `pending`.
   */
  protected override async beforeSelect(tx: DrizzleTx): Promise<void> {
    const now = new Date();
    const cutoff = new Date(now.getTime() - this.maxAgeHours * MS_PER_HOUR);
    const stale = await tx
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.status, 'pending'),
          lt(webhookDeliveries.createdAt, cutoff),
          or(isNull(webhookDeliveries.lockedUntil), lte(webhookDeliveries.lockedUntil, now)),
        ),
      )
      .orderBy(asc(webhookDeliveries.seq), asc(webhookDeliveries.id))
      .limit(EXPIRE_PER_CLAIM)
      .for('update', { skipLocked: true });
    if (stale.length === 0) return;

    const expired = await tx
      .update(webhookDeliveries)
      .set({
        status: 'failed',
        lastError: `expired: pending longer than ${this.maxAgeHours} h`,
        leaseToken: null,
        lockedUntil: null,
      })
      .where(
        and(
          inArray(
            webhookDeliveries.id,
            stale.map((r) => r.id),
          ),
          eq(webhookDeliveries.status, 'pending'),
        ),
      )
      .returning({ id: webhookDeliveries.id });
    this.recordExpired(expired.length);
    this.logger.warn(
      { expired: expired.length, maxAgeHours: this.maxAgeHours },
      `Expired ${expired.length} webhook deliver(ies) pending longer than ${this.maxAgeHours} h; not sent`,
    );
  }

  @Cron('*/10 * * * * *', { name: 'webhook-relay' })
  @Span('webhook.relay')
  override async relay(): Promise<void> {
    return super.relay();
  }

  /** Held for the SUM of the batch's leases (2 min each): 5 rows is 10 minutes if a worker dies. */
  protected override readonly batchSize = 5;

  protected readonly outbox: OutboxLeaseTable = {
    table: webhookDeliveries,
    id: webhookDeliveries.id,
    status: webhookDeliveries.status,
    attempts: webhookDeliveries.attempts,
    lastError: webhookDeliveries.lastError,
    leaseToken: webhookDeliveries.leaseToken,
    lockedUntil: webhookDeliveries.lockedUntil,
    seq: webhookDeliveries.seq,
  };

  protected async selectDue(tx: DrizzleTx, limit: number, now: Date): Promise<DeliveryRow[]> {
    /*
     * `FOR UPDATE OF <table>`, because the join to `webhook_subscriptions` must NOT lock subscriptions: an API call
     * editing or deleting a subscription would otherwise wait behind a relay pass, and two relays could never
     * claim different deliveries of the same subscription.
     *
     * The table is ALIASED, and `of` names the alias. Postgres requires the `OF` operand to be an UNQUALIFIED
     * relation name (a table, or its alias), and Drizzle renders `of: webhookDeliveries` as the qualified
     * `"messaging"."webhook_deliveries"` for a table in a `pgSchema`, which Postgres rejects with `FOR UPDATE must
     * specify unqualified relation names`: this relay failed every pass, and no delivery was ever made. Aliased, the
     * query renders `... from "messaging"."webhook_deliveries" "d" ... for update of "d" skip locked`.
     * (test/e2e/webhook-relay-claim.e2e.spec.ts runs this query against PostgreSQL.)
     */
    const d = alias(webhookDeliveries, 'd');
    return tx
      .select({
        id: d.id,
        subscriptionId: d.subscriptionId,
        eventType: d.eventType,
        payload: d.payload,
        attempts: d.attempts,
        url: webhookSubscriptions.url,
        secret: webhookSubscriptions.secret,
      })
      .from(d)
      .innerJoin(
        webhookSubscriptions,
        and(eq(d.subscriptionId, webhookSubscriptions.id), eq(webhookSubscriptions.active, true)),
      )
      .where(
        and(
          eq(d.status, 'pending'),
          lt(d.attempts, this.maxAttempts),
          lte(d.nextAttemptAt, now),
          // `this.notLeased(now)` says the same about the UNALIASED column, which no longer exists in this query:
          // the table is `d` here. Same predicate, written against the alias.
          or(isNull(d.lockedUntil), lte(d.lockedUntil, now)),
        ),
      )
      .orderBy(asc(d.seq), asc(d.id))
      .limit(limit)
      .for('update', { skipLocked: true, of: d });
  }

  /** The HTTP POST, with NO transaction open: a slow receiver holds a connection, not row locks. */
  protected async deliver(row: Claimed<DeliveryRow>): Promise<void> {
    /*
     * CHECKED HERE AS WELL AS AT WRITE TIME, because they are different moments. The DTO judged the
     * string when the subscription was saved; this resolves the name now. A host that pointed somewhere
     * public then can point at `10.0.0.5` today, and the stored URL is unchanged either way.
     *
     * Thrown rather than skipped, so the row follows the ordinary failure path — the reason lands in
     * `last_error` where the subscription's owner can read it, and it dead-letters like anything else.
     * Silently dropping it would leave a subscription that looks healthy and delivers nothing.
     */
    const unsafe = await describeUnsafeResolvedTarget(row.url);
    if (unsafe) {
      throw new Error(`Refusing to deliver to ${row.url}: ${unsafe}`);
    }

    const timestamp = new Date().toISOString();
    const body = JSON.stringify({
      id: row.id,
      eventType: row.eventType,
      payload: row.payload,
      timestamp,
    });

    const sig = `sha256=${createHmac('sha256', row.secret).update(body).digest('hex')}`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), WEBHOOK_TIMEOUT_MS);
    try {
      const res = await fetch(row.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-OpsHub-Signature': sig,
          'X-OpsHub-Event': row.eventType,
          'X-OpsHub-Delivery': row.id,
        },
        body,
        signal: ctrl.signal,
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  protected async markSent(tx: DrizzleTx, row: Claimed<DeliveryRow>): Promise<void> {
    await tx
      .update(webhookDeliveries)
      .set({ status: 'delivered', deliveredAt: new Date() })
      .where(eq(webhookDeliveries.id, row.id));
  }

  protected async markFailed(
    tx: DrizzleTx,
    row: Claimed<DeliveryRow>,
    newStatus: 'pending' | 'failed',
    error: string,
    // Deliberately IGNORED: webhook deliveries follow their own RETRY_DELAYS_SECONDS curve,
    // which is a per-endpoint contract rather than a generic backoff. The base class passes
    // its default so a relay that has no opinion gets one for free; this one has an opinion.
    _nextAttemptAt: Date,
  ): Promise<void> {
    const delaySeconds =
      RETRY_DELAYS_SECONDS[Math.min(row.attempts - 1, RETRY_DELAYS_SECONDS.length - 1)] ?? 3600;
    const nextAttemptAt = new Date(Date.now() + delaySeconds * MS_PER_SEC);
    await tx
      .update(webhookDeliveries)
      .set({
        status: newStatus,
        lastError: error.slice(0, MAX_DELIVERY_ERROR_LENGTH),
        nextAttemptAt: newStatus === 'failed' ? new Date() : nextAttemptAt,
      })
      .where(eq(webhookDeliveries.id, row.id));
  }
}
