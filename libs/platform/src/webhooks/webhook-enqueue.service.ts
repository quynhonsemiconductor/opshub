import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { newId } from '@shared-kernel';
import { webhookSubscriptions, webhookDeliveries } from '../../../../db/schema';
import type { DbExecutor } from '../database/drizzle.provider';
import { notifyOutbox } from '../outbox/outbox-wake';

/**
 * WebhookEnqueueService — used inside DB transactions to fan domain events out
 * to matching webhook subscriptions.
 *
 * Called from the RequestEngine after every state transition so webhook delivery
 * rows are written atomically alongside the request state update.
 */
@Injectable()
export class WebhookEnqueueService {
  /**
   * Reads all active subscriptions that include `eventType` in their events array
   * and inserts a `webhook_deliveries` row for each one — all within the caller's
   * transaction.
   *
   * Silently no-ops if no subscriptions match.
   */
  async fanout(tx: DbExecutor, eventType: string, payload: Record<string, unknown>): Promise<void> {
    // PostgreSQL array containment: events @> ARRAY[eventType]::text[]
    const subs = await tx
      .select({ id: webhookSubscriptions.id })
      .from(webhookSubscriptions)
      .where(
        and(
          eq(webhookSubscriptions.active, true),
          sql`${webhookSubscriptions.events} @> ARRAY[${eventType}]::text[]`,
        ),
      );

    if (subs.length === 0) return;

    // next_attempt_at is left to the database default: now() is the one clock for the relay's due check (the Time rule).
    await tx.insert(webhookDeliveries).values(
      subs.map((s) => ({
        id: newId(),
        subscriptionId: s.id,
        eventType,
        payload,
        status: 'pending' as const,
        attempts: 0,
      })),
    );
    await notifyOutbox(tx, 'webhook');
  }
}
