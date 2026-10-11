/**
 * NotificationRelayService — polls notification_outbox and dispatches in-app
 * notifications via NotificationsService.
 *
 * Extends AbstractOutboxRelay which owns the polling loop, concurrency guard,
 * transaction management, and retry/fail logic.
 *
 * Adaptive polling:
 *   NotificationSchedulerService.schedule() publishes a relay:wake signal to
 *   Redis immediately after writing to notification_outbox.  onModuleInit()
 *   subscribes and calls super.relay() directly — delivery latency drops from
 *   ≤5s (cron) to ~ms (wake signal).  The 5s cron is the catch-all fallback.
 *
 * Post-commit SSE push:
 *   processRow() returns a PostCommitTask that publishes to Redis AFTER the
 *   transaction commits so the SSE controller never receives an event before
 *   in_app_notifications is durable.
 *
 * Email cascade:
 *   A notification the recipient wants by email is enqueued into `email_outbox` IN THIS RELAY'S
 *   TRANSACTION, so the enqueue and this row's `sent` transition commit together. Before this, the
 *   entire email half of notifications was dead: nothing anywhere called `EmailSchedulerService`, so
 *   `email_outbox` was always empty, `EmailRelayService` polled it every five seconds forever, five
 *   templates never rendered, and `notification_preferences.email` — a column defaulting to `true` —
 *   was honoured nowhere. Anybody who left the box ticked got silence.
 *
 *   The sibling repo does this enqueue in its post-commit task and swallows the error, which makes it a
 *   dual write: the notification row is already `sent`, so a failure loses the email with nothing left
 *   pending to retry. Here a failure rolls the row back and the relay tries again.
 */
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { and, asc, eq, lt, lte } from 'drizzle-orm';
import { InjectDrizzle, Span } from '@platform';
import type { DrizzleDB, DrizzleTx } from '@platform';
import { AbstractOutboxRelay } from '@platform';
import type { Claimed, OutboxLeaseTable, PostCommitTask } from '@platform';
import { renderNotification, NotificationPubSubService } from '@platform/notifications';
import type { NotificationTemplateName, NotificationTemplateVars } from '@platform/notifications';
import { notificationOutbox } from '../../../../../db/schema';
import { AppConfigService } from '@platform';
import { EmailSchedulerService } from '@platform/email';
import { employees } from '../../../../../db/schema';
import { NotificationsService } from './notifications.service';
import { NotificationPreferencesService } from './notification-preferences.service';

type NotificationOutboxRow = {
  id: string;
  recipientId: string;
  actorId: string | null;
  type: string;
  vars: unknown;
  resourceId: string | null;
  attempts: number;
  idempotencyKey: string | null;
};

@Injectable()
export class NotificationRelayService
  extends AbstractOutboxRelay<NotificationOutboxRow>
  implements OnModuleInit, OnModuleDestroy
{
  private unsubscribeRelayWake?: () => Promise<void>;

  constructor(
    @InjectDrizzle() db: DrizzleDB,
    private readonly notificationsService: NotificationsService,
    private readonly pubSub: NotificationPubSubService,
    private readonly prefs: NotificationPreferencesService,
    private readonly emailScheduler: EmailSchedulerService,
    private readonly config: AppConfigService,
  ) {
    super(db);
  }

  async onModuleInit(): Promise<void> {
    this.logger.log('Notification relay started — polling notification_outbox every 5s');
    this.unsubscribeRelayWake = await this.pubSub.subscribeRelayWake(() => {
      this.relay().catch((err: unknown) =>
        this.logger.error({ err }, 'Notification relay triggered by wake signal failed'),
      );
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.unsubscribeRelayWake?.();
  }

  @Cron('*/5 * * * * *', { name: 'notification-relay' })
  @Span('notification.relay')
  override async relay(): Promise<void> {
    return super.relay();
  }

  // ── AbstractOutboxRelay implementation ────────────────────────────────────

  protected readonly outbox: OutboxLeaseTable = {
    table: notificationOutbox,
    id: notificationOutbox.id,
    status: notificationOutbox.status,
    attempts: notificationOutbox.attempts,
    lastError: notificationOutbox.lastError,
    leaseToken: notificationOutbox.leaseToken,
    lockedUntil: notificationOutbox.lockedUntil,
    seq: notificationOutbox.seq,
  };

  protected async selectDue(
    tx: DrizzleTx,
    limit: number,
    now: Date,
  ): Promise<NotificationOutboxRow[]> {
    return tx
      .select({
        id: notificationOutbox.id,
        recipientId: notificationOutbox.recipientId,
        actorId: notificationOutbox.actorId,
        type: notificationOutbox.type,
        vars: notificationOutbox.vars,
        resourceId: notificationOutbox.resourceId,
        attempts: notificationOutbox.attempts,
        idempotencyKey: notificationOutbox.idempotencyKey,
      })
      .from(notificationOutbox)
      .where(
        and(
          eq(notificationOutbox.status, 'pending'),
          lt(notificationOutbox.attempts, this.maxAttempts),
          lte(notificationOutbox.scheduledAt, now),
          this.notLeased(now),
        ),
      )
      .orderBy(asc(notificationOutbox.seq))
      .limit(limit)
      .for('update', { skipLocked: true });
  }

  /**
   * Nothing leaves the database here — the in-app row and the email cascade are database writes — so
   * the whole body is `settle`, inside the fenced finish transaction, where it commits atomically with
   * the outbox row going to sent. The SSE push is a post-commit task.
   */
  protected async deliver(): Promise<void> {
    // intentionally empty: see settle()
  }

  protected async settle(
    row: Claimed<NotificationOutboxRow>,
    _result: void,
    tx: DrizzleTx,
  ): Promise<PostCommitTask | void> {
    // Check in-app preference before dispatching.
    const inAppEnabled = await this.prefs.isInAppEnabled(row.recipientId, row.type);
    if (!inAppEnabled) {
      this.logger.debug(
        { recipientId: row.recipientId, type: row.type },
        'In-app notification suppressed by preference',
      );
      return; // AbstractOutboxRelay marks the row as sent (dispatched)
    }

    const type = row.type as NotificationTemplateName;
    const vars = row.vars as NotificationTemplateVars[typeof type];
    const rendered = renderNotification(type, vars as never);

    const notification = await this.notificationsService.send(
      {
        recipientId: row.recipientId,
        actorId: row.actorId ?? undefined,
        type,
        title: rendered.title,
        body: rendered.body,
        resourceId: row.resourceId ?? undefined,
        // The OUTBOX ROW ID, never the idempotency key. These are two different dedup
        // mechanisms on two different columns and conflating them broke every notification
        // that wanted deduplication:
        //
        //   notification_outbox.idempotency_key  TEXT, unique  → dedups at ENQUEUE
        //     ('ar_step1_notify:<uuid>', 'sla_breach:<uuid>', 'request_submitted:<uuid>')
        //   in_app_notifications.source_event_id UUID, unique  → dedups at DELIVERY
        //
        // Passing the text key into the uuid column made Postgres reject it with
        // `invalid input syntax for type uuid`, so the row burned all five attempts and
        // dead-lettered. SLA-breach, request-submitted and access-request step
        // notifications were all silently lost; notifications with no key fell back to
        // row.id and worked, which is why it went unnoticed.
        //
        // row.id is one uuid per outbox row, so delivery stays exactly-once per row while
        // the outbox's own unique index keeps duplicate ENQUEUES out in the first place.
        sourceEventId: row.id,
      },
      // THE RELAY'S TRANSACTION. Without it this was a dual write: a rollback left the notification
      // delivered on another connection while the outbox row returned to `pending`, and the retry then
      // found it already existed, returned null, and skipped the email cascade for good.
      tx,
    );

    // If notification was deduplicated (already exists), no SSE push and no second email.
    if (!notification) return;

    await this.cascadeToEmail(row, rendered, notification.id, tx);

    return async () => {
      await this.pubSub.notifyUser({
        notificationId: notification.id,
        recipientId: row.recipientId,
        type,
        title: rendered.title,
        body: rendered.body,
        resourceId: row.resourceId ?? undefined,
      });
    };
  }

  /**
   * Enqueue the email half of one notification, if the recipient wants it.
   *
   * IN THE RELAY'S TRANSACTION. `tx` is the same handle `markSent` writes into, so either the email is
   * queued and the notification row is marked sent, or neither happened and the row stays pending for
   * the next pass. That is what makes this an outbox chain rather than two independent writes.
   *
   * KEYED ON THE IN-APP NOTIFICATION ID, which is itself deduplicated by `source_event_id`. So a
   * replayed outbox row cannot produce a second email: the notification insert returns null, this method
   * is never reached, and even if it were, `uq_email_outbox_idempotency` refuses the duplicate.
   *
   * A RECIPIENT WITH NO EMAIL ADDRESS is skipped rather than failed. The address is on the employee
   * record and an offboarded or partially-provisioned row can lack one; failing here would dead-letter a
   * notification that was delivered in-app perfectly well.
   */
  private async cascadeToEmail(
    row: NotificationOutboxRow,
    rendered: { title: string; body: string | null },
    notificationId: string,
    tx: DrizzleTx,
  ): Promise<void> {
    const emailEnabled = await this.prefs.isEmailEnabled(row.recipientId, row.type);
    this.logger.warn(
      { PROBE: 'cascade', recipientId: row.recipientId, type: row.type, emailEnabled },
      'PROBE cascade entered',
    );
    if (!emailEnabled) return;

    const [recipient] = await tx
      .select({ email: employees.email })
      .from(employees)
      .where(eq(employees.id, row.recipientId))
      .limit(1);

    if (!recipient?.email) {
      this.logger.warn(
        { recipientId: row.recipientId, type: row.type },
        'Notification email skipped — recipient has no email address',
      );
      return;
    }

    await this.emailScheduler.schedule(
      tx,
      recipient.email,
      'notification',
      { title: rendered.title, body: rendered.body, appUrl: this.config.get('APP_URL') },
      {
        idempotencyKey: `notification-email:${notificationId}`,
        recipientId: row.recipientId,
      },
    );
  }

  protected async markSent(tx: DrizzleTx, row: Claimed<NotificationOutboxRow>): Promise<void> {
    await tx
      .update(notificationOutbox)
      .set({ status: 'sent', dispatchedAt: new Date() })
      .where(eq(notificationOutbox.id, row.id));
  }

  protected async markFailed(
    tx: DrizzleTx,
    row: Claimed<NotificationOutboxRow>,
    newStatus: 'pending' | 'failed',
    lastError: string,
    nextAttemptAt: Date,
  ): Promise<void> {
    await tx
      .update(notificationOutbox)
      // scheduledAt IS the retry gate — selectDue selects on `scheduledAt <= now()`, so leaving it alone
      // made every retry immediate and burned all five attempts inside ~25 seconds. A dependency blip
      // therefore dead-lettered the row permanently.
      .set({ status: newStatus, lastError, scheduledAt: nextAttemptAt })
      .where(eq(notificationOutbox.id, row.id));
  }
}
