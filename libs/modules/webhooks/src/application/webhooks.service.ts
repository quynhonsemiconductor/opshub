import { Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { DB_NOW, InjectDrizzle, NotFoundException, ErrorCodes } from '@platform';
import type { DrizzleDB } from '@platform';
import { newId } from '@shared-kernel';
import { webhookSubscriptions, webhookDeliveries } from '../../../../../db/schema';
import type {
  WebhookSubscription,
  WebhookDelivery,
  CreateSubscriptionInput,
} from '../domain/webhook.types';

function rowToSubscription(r: typeof webhookSubscriptions.$inferSelect): WebhookSubscription {
  return {
    id: r.id,
    url: r.url,
    events: r.events,
    description: r.description ?? null,
    active: r.active,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function rowToDelivery(r: typeof webhookDeliveries.$inferSelect): WebhookDelivery {
  return {
    id: r.id,
    subscriptionId: r.subscriptionId,
    eventType: r.eventType,
    payload: r.payload,
    status: r.status as WebhookDelivery['status'],
    attempts: r.attempts,
    nextAttemptAt: r.nextAttemptAt,
    deliveredAt: r.deliveredAt ?? null,
    lastError: r.lastError ?? null,
    createdAt: r.createdAt,
  };
}

@Injectable()
export class WebhooksService {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  // ── Subscriptions ──────────────────────────────────────────────────────────

  async create(input: CreateSubscriptionInput): Promise<WebhookSubscription> {
    const [row] = await this.db
      .insert(webhookSubscriptions)
      .values({
        id: newId(),
        url: input.url,
        secret: input.secret,
        events: input.events,
        description: input.description ?? null,
      })
      .returning();
    return rowToSubscription(row);
  }

  async list(): Promise<WebhookSubscription[]> {
    const rows = await this.db.select().from(webhookSubscriptions);
    return rows.map(rowToSubscription);
  }

  async getById(id: string): Promise<WebhookSubscription> {
    const [row] = await this.db
      .select()
      .from(webhookSubscriptions)
      .where(eq(webhookSubscriptions.id, id))
      .limit(1);
    if (!row)
      throw new NotFoundException(ErrorCodes.WEBHOOK_NOT_FOUND, 'Webhook subscription not found');
    return rowToSubscription(row);
  }

  async setActive(id: string, active: boolean): Promise<WebhookSubscription> {
    const [row] = await this.db
      .update(webhookSubscriptions)
      .set({ active, updatedAt: new Date() })
      .where(eq(webhookSubscriptions.id, id))
      .returning();
    if (!row)
      throw new NotFoundException(ErrorCodes.WEBHOOK_NOT_FOUND, 'Webhook subscription not found');
    return rowToSubscription(row);
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(webhookSubscriptions).where(eq(webhookSubscriptions.id, id));
  }

  // ── Deliveries ─────────────────────────────────────────────────────────────

  async listDeliveries(subscriptionId: string): Promise<WebhookDelivery[]> {
    const rows = await this.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.subscriptionId, subscriptionId))
      // NEWEST FIRST, and capped. Unordered, this returned an arbitrary 100 of however many
      // deliveries the subscription has — on the screen somebody opens to find out why the last one
      // failed, which is the one attempt it was least likely to include.
      .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
      .limit(100);
    return rows.map(rowToDelivery);
  }

  /**
   * Retry a failed delivery by resetting it to pending with nextAttemptAt = the database now() (DB_NOW).
   */
  async retryDelivery(deliveryId: string): Promise<WebhookDelivery> {
    const [row] = await this.db
      .update(webhookDeliveries)
      .set({ status: 'pending', nextAttemptAt: DB_NOW, lastError: null })
      .where(eq(webhookDeliveries.id, deliveryId))
      .returning();
    if (!row)
      throw new NotFoundException(ErrorCodes.DELIVERY_NOT_FOUND, 'Webhook delivery not found');
    return rowToDelivery(row);
  }
}
