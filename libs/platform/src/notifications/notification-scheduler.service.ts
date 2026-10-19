import { Injectable } from '@nestjs/common';
import { type DrizzleDB, type DbExecutor } from '../database/drizzle.provider';
import { notificationOutbox } from '../../../../db/schema';
import {
  type NotificationTemplateName,
  type NotificationTemplateVars,
} from './notification.templates';
import { notifyOutbox } from '../outbox/outbox-wake';

export interface ScheduleNotificationInput<K extends NotificationTemplateName> {
  type: K;
  vars: NotificationTemplateVars[K];
  recipientId: string;
  actorId?: string;
  resourceId?: string;
  idempotencyKey?: string;
}

/**
 * NotificationSchedulerService — enqueue a notification into notification_outbox
 * inside the caller's existing DB transaction.
 *
 * The relay (NotificationRelayService) reads these rows every 5 s. A NOTIFY in the same transaction wakes it early:
 * delivered at commit, so the relay never wakes for a row that was rolled back.
 */
@Injectable()
export class NotificationSchedulerService {
  async schedule<K extends NotificationTemplateName>(
    tx: DbExecutor,
    input: ScheduleNotificationInput<K>,
  ): Promise<void> {
    await (tx as DrizzleDB)
      .insert(notificationOutbox)
      .values({
        recipientId: input.recipientId,
        actorId: input.actorId ?? null,
        type: input.type,
        vars: input.vars as Record<string, unknown>,
        resourceId: input.resourceId ?? null,
        status: 'pending',
        idempotencyKey: input.idempotencyKey ?? null,
      })
      .onConflictDoNothing();

    // The wake hint. Polling is the source of truth: a lost notify is picked up by the next tick.
    await notifyOutbox(tx, 'notification');
  }
}
