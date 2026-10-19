/**
 * EmailRelayService — polls email_outbox and dispatches via EmailService.
 *
 * Extends AbstractOutboxRelay which owns the polling loop, concurrency guard,
 * transaction management, and retry/fail logic.
 *
 * Adaptive polling:
 *   EmailSchedulerService.schedule() sends a NOTIFY in the same transaction as the insert. OutboxWakeService
 *   (worker only) calls relay() on it, so delivery does not wait for the 5s cron. The cron is the fallback.
 */
import { Injectable, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { and, asc, eq, lt, lte, type SQL } from 'drizzle-orm';
import { DB_NOW, dbDelay, InjectDrizzle, Span } from '@platform';
import type { DrizzleDB, DrizzleTx } from '@platform';
import { AbstractOutboxRelay } from '@platform';
import type { Claimed, OutboxLeaseTable } from '@platform';
import { getProcessRole } from '@platform/config/process-role';
import { EmailService } from '@platform/email';
import { EMAIL_SEND_TIMEOUT_MS } from '@platform/email';
import type { EmailTemplateName, EmailTemplateVars } from '@platform/email';
import { emailOutbox } from '../../../../../db/schema';

/** Database round trips and scheduling slack on top of the send itself. */
export const EMAIL_LEASE_MARGIN_MS = 60_000;

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
  extends AbstractOutboxRelay<EmailOutboxRow, string | null>
  implements OnModuleInit
{
  constructor(
    @InjectDrizzle() db: DrizzleDB,
    private readonly emailService: EmailService,
  ) {
    super(db);
  }

  onModuleInit(): void {
    /*
     * ONLY THE WORKER SENDS. The API writes outbox rows and publishes the wake signal; it holds no mail credential (its schema refuses the
     * Graph variables, and its task has no SES grant), so a relay pass in the API would try to send with none. Without this the API
     * subscribed to its own wake signal and ran the relay too. `relay()` below enforces the same rule for any other caller.
     */
    if (getProcessRole() !== 'worker') {
      this.logger.log('Email relay idle: this is not the worker process');
      return;
    }
    // Fail the deploy, not the first invitation, if the configured transport cannot work (a missing Graph variable).
    this.emailService.assertReady();
    this.logger.log('Email relay started — polling email_outbox every 5s');
  }

  @Cron('*/5 * * * * *', { name: 'email-relay' })
  @Span('email.relay')
  override async relay(): Promise<void> {
    // Whoever calls it (the cron, the wake signal, a test): only the worker sends.
    if (getProcessRole() !== 'worker') return;
    return super.relay();
  }

  // ── AbstractOutboxRelay implementation ────────────────────────────────────

  protected readonly outbox: OutboxLeaseTable = {
    table: emailOutbox,
    id: emailOutbox.id,
    status: emailOutbox.status,
    attempts: emailOutbox.attempts,
    lastError: emailOutbox.lastError,
    leaseToken: emailOutbox.leaseToken,
    lockedUntil: emailOutbox.lockedUntil,
    seq: emailOutbox.seq,
  };

  /** Held for the SUM of the batch's leases (90 s each): 5 rows is 7.5 minutes if a worker dies. */
  protected override readonly batchSize = 5;

  /**
   * One provider send, bounded by EMAIL_SEND_TIMEOUT_MS, plus a margin for the database and scheduling.
   * The lease must outlive the call it covers: a send still in flight after the lease lapsed is a send
   * another relay can repeat, and a row the reaper dead-letters while it is being delivered.
   */
  protected leaseMsFor(): number {
    return EMAIL_SEND_TIMEOUT_MS + EMAIL_LEASE_MARGIN_MS;
  }

  protected async selectDue(tx: DrizzleTx, limit: number, now: SQL): Promise<EmailOutboxRow[]> {
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
          lte(emailOutbox.scheduledAt, now),
          this.notLeased(now),
        ),
      )
      .orderBy(asc(emailOutbox.seq), asc(emailOutbox.id))
      .limit(limit)
      .for('update', { skipLocked: true });
  }

  /** Sends with NO transaction open. Resolves to the provider's message id (null for providers without one). */
  protected async deliver(row: Claimed<EmailOutboxRow>): Promise<string | null> {
    const sent = await this.emailService.sendTemplate(
      row.to,
      row.template as EmailTemplateName,
      row.vars as EmailTemplateVars[EmailTemplateName],
      { idempotencyKey: row.idempotencyKey ?? row.id },
    );
    return sent.messageId;
  }

  protected async markSent(
    tx: DrizzleTx,
    row: Claimed<EmailOutboxRow>,
    messageId: string | null,
  ): Promise<void> {
    // The provider's message id is persisted in the SAME transaction that flips the row to sent: it is
    // the feedback loop's only exact match key, and storing it anywhere looser than the status write
    // risks a `sent` row that can never be bounce-matched.
    await tx
      .update(emailOutbox)
      .set({ status: 'sent', sentAt: DB_NOW, messageId })
      .where(eq(emailOutbox.id, row.id));
  }

  protected async markFailed(
    tx: DrizzleTx,
    row: Claimed<EmailOutboxRow>,
    newStatus: 'pending' | 'failed',
    lastError: string,
    delayMs: number,
  ): Promise<void> {
    await tx
      .update(emailOutbox)
      // scheduledAt IS the retry gate — selectDue selects on `scheduledAt <= now()`, so leaving it alone
      // made every retry immediate and burned all five attempts inside ~25 seconds.
      .set({ status: newStatus, lastError, scheduledAt: dbDelay(delayMs) })
      .where(eq(emailOutbox.id, row.id));
  }
}
