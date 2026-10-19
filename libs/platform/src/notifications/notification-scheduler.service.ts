import { Injectable } from '@nestjs/common';
import { type DrizzleDB, type DbExecutor } from '../database/drizzle.provider';
import { notificationOutbox } from '../../../../db/schema';
import { type NotificationTemplateName, type NotificationTemplateVars } from './notification.templates';
import { NotificationPubSubService } from './notification-pubsub.service';

export interface ScheduleNotificationInput<K extends NotificationTemplateName> {
  type:            K;
  vars:            NotificationTemplateVars[K];
  recipientId:     string;
  actorId?:        string;
  resourceId?:     string;
  idempotencyKey?: string;
}

/**
 * NotificationSchedulerService — enqueue a notification into notification_outbox
 * inside the caller's existing DB transaction.
 *
 * The relay (NotificationRelayService) reads these rows every 5 s.
 * A wake signal is published to Redis after each insert for near-zero latency.
 */
@Injectable()
export class NotificationSchedulerService {
  constructor(private readonly pubSub: NotificationPubSubService) {}

  async schedule<K extends NotificationTemplateName>(
    tx:    DbExecutor,
    input: ScheduleNotificationInput<K>,
  ): Promise<void> {
    await (tx as DrizzleDB)
      .insert(notificationOutbox)
      .values({
        recipientId:    input.recipientId,
        actorId:        input.actorId       ?? null,
        type:           input.type,
        vars:           input.vars as Record<string, unknown>,
        resourceId:     input.resourceId    ?? null,
        status:         'pending',
        idempotencyKey: input.idempotencyKey ?? null,
      })
      .onConflictDoNothing();

    // Best-effort wake signal — reduces relay latency from ≤5s to ~ms.
    // Fire-and-forget; correctness is guaranteed by cron polling regardless.
    this.pubSub.wakeRelay().catch(() => { /* non-critical */ });
  }
}
