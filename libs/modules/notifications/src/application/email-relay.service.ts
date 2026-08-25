/**
 * EmailRelayService — polls email_outbox and dispatches via EmailService.
 *
 * Extends AbstractOutboxRelay which owns the polling loop, concurrency guard,
 * transaction management, and retry/fail logic.
 *
 * Adaptive polling:
 *   EmailSchedulerService.schedule() publishes an email:relay:wake signal to
 *   Redis immediately after writing to email_outbox.  onModuleInit() subscribes
 *   and calls super.relay() — delivery latency drops from ≤5s to ~ms.
 */
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { and, asc, eq, lt, lte } from 'drizzle-orm';
import { InjectDrizzle, Span } from '@platform';
import type { DrizzleDB, DrizzleTx } from '@platform';
import { AbstractOutboxRelay } from '@platform';
import type { PostCommitTask } from '@platform';
import { EmailService } from '@platform/email';
import type { EmailTemplateName, EmailTemplateVars } from '@platform/email';
import { NotificationPubSubService } from '@platform/notifications';
import { emailOutbox } from '../../../../../db/schema';

type EmailOutboxRow = {
  id: string;
  to: string;
  template: string;
  vars: unknown;
  attempts: number;
  idempotencyKey: string | null;
};

@Injectable()
export class EmailRelayService
  extends AbstractOutboxRelay<EmailOutboxRow>
  implements OnModuleInit, OnModuleDestroy
{
  private unsubscribeRelayWake?: () => Promise<void>;

  constructor(
    @InjectDrizzle() db: DrizzleDB,
    private readonly emailService: EmailService,
    private readonly pubSub: NotificationPubSubService,
  ) {
    super(db);
  }

  async onModuleInit(): Promise<void> {
    this.logger.log('Email relay started — polling email_outbox every 5s');
    this.unsubscribeRelayWake = await this.pubSub.subscribeEmailRelayWake(() => {
      this.relay().catch((err: unknown) =>
        this.logger.error({ err }, 'Email relay triggered by wake signal failed'),
      );
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.unsubscribeRelayWake?.();
  }

  @Cron('*/5 * * * * *', { name: 'email-relay' })
  @Span('email.relay')
  override async relay(): Promise<void> {
    return super.relay();
  }

  // ── AbstractOutboxRelay implementation ────────────────────────────────────

  protected async fetchBatch(tx: DrizzleTx): Promise<EmailOutboxRow[]> {
    return tx
      .select({
        id: emailOutbox.id,
        to: emailOutbox.to,
        template: emailOutbox.template,
        vars: emailOutbox.vars,
        attempts: emailOutbox.attempts,
        idempotencyKey: emailOutbox.idempotencyKey,
      })
      .from(emailOutbox)
      .where(
        and(
          eq(emailOutbox.status, 'pending'),
          lt(emailOutbox.attempts, this.maxAttempts),
          lte(emailOutbox.scheduledAt, new Date()),
        ),
      )
      .orderBy(asc(emailOutbox.scheduledAt), asc(emailOutbox.id))
      .limit(this.batchSize)
      .for('update', { skipLocked: true });
  }

  protected async processRow(row: EmailOutboxRow, _tx: DrizzleTx): Promise<PostCommitTask | void> {
    // Held so markSent can persist it in the SAME transaction that flips the row to
    // sent: the provider's message id is the feedback loop's only exact match key, and
    // storing it anywhere looser than the status write risks a `sent` row that can never
    // be bounce-matched.
    this.pendingMessageId = (
      await this.emailService.sendTemplate(
        row.to,
        row.template as EmailTemplateName,
        row.vars as EmailTemplateVars[EmailTemplateName],
        { idempotencyKey: row.idempotencyKey ?? row.id },
      )
    ).messageId;
    // No post-commit work needed — email dispatch is synchronous within processRow.
  }

  /** Message id from the most recent processRow in this relay pass. See processRow. */
  private pendingMessageId: string | null = null;

  protected async markSent(tx: DrizzleTx, rowId: string): Promise<void> {
    await tx
      .update(emailOutbox)
      .set({ status: 'sent', sentAt: new Date(), messageId: this.pendingMessageId })
      .where(eq(emailOutbox.id, rowId));
    this.pendingMessageId = null;
  }

  protected async markFailed(
    tx: DrizzleTx,
    rowId: string,
    newAttempts: number,
    newStatus: 'pending' | 'failed',
    lastError: string,
    nextAttemptAt: Date,
  ): Promise<void> {
    await tx
      .update(emailOutbox)
      // scheduledAt IS the retry gate — fetchBatch selects on `scheduledAt <= now()`, so
      // leaving it alone made every retry immediate and burned all five attempts inside
      // ~25 seconds. A dependency blip therefore dead-lettered the row permanently.
      .set({ attempts: newAttempts, status: newStatus, lastError, scheduledAt: nextAttemptAt })
      .where(eq(emailOutbox.id, rowId));
  }
}
