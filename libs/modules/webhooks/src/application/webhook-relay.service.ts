import { Injectable } from '@nestjs/common';
import { and, asc, eq, lt, lte } from 'drizzle-orm';
import { Cron } from '@nestjs/schedule';
import { createHmac } from 'crypto';
import { AbstractOutboxRelay, InjectDrizzle, Span, describeUnsafeResolvedTarget } from '@platform';
import type { Claimed, DrizzleDB, DrizzleTx, OutboxLeaseTable } from '@platform';
import { webhookDeliveries, webhookSubscriptions } from '../../../../../db/schema';
import { MS_PER_SEC } from '@shared-kernel';

const WEBHOOK_TIMEOUT_MS = 10_000; // 10s per delivery attempt
const RETRY_DELAYS_SECONDS = [60, 300, 900, 3600]; // 1m → 5m → 15m → 1h
const MAX_DELIVERY_ERROR_LENGTH = 2_000; // chars stored in lastError column

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
  constructor(@InjectDrizzle() db: DrizzleDB) {
    super(db);
  }

  @Cron('*/10 * * * * *', { name: 'webhook-relay' })
  @Span('webhook.relay')
  override async relay(): Promise<void> {
    return super.relay();
  }

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
    return tx
      .select({
        id: webhookDeliveries.id,
        subscriptionId: webhookDeliveries.subscriptionId,
        eventType: webhookDeliveries.eventType,
        payload: webhookDeliveries.payload,
        attempts: webhookDeliveries.attempts,
        url: webhookSubscriptions.url,
        secret: webhookSubscriptions.secret,
      })
      .from(webhookDeliveries)
      .innerJoin(
        webhookSubscriptions,
        and(
          eq(webhookDeliveries.subscriptionId, webhookSubscriptions.id),
          eq(webhookSubscriptions.active, true),
        ),
      )
      .where(
        and(
          eq(webhookDeliveries.status, 'pending'),
          lt(webhookDeliveries.attempts, this.maxAttempts),
          lte(webhookDeliveries.nextAttemptAt, now),
          this.notLeased(now),
        ),
      )
      .orderBy(asc(webhookDeliveries.seq), asc(webhookDeliveries.id))
      .limit(limit)
      .for('update', { skipLocked: true, of: webhookDeliveries });
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
