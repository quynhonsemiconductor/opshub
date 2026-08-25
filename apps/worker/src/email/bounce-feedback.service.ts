/**
 * BounceFeedbackService — drains SES bounce/complaint verdicts onto the rows that sent them.
 *
 * `email_outbox.status = 'sent'` means ACCEPTED BY THE PROVIDER, and SES accepts before the
 * receiving mail server has said anything — so a hard-bounced invitation and a delivered one
 * are indistinguishable until this service hears the difference. The loop it closes cost a
 * multi-day investigation: an invitation accepted by SES, quarantined by the receiving
 * tenant, invisible to the invitee, and shown to the inviter as plain "sent".
 *
 * PLUMBING: SES cannot write to SQS directly — its event destinations are SNS, Kinesis or
 * EventBridge — so the configuration set's bounce and complaint events fan out
 * SNS → SQS → here (infra/live/_shared owns all three). SQS rather than an HTTPS endpoint
 * on purpose: no public unauthenticated route to signature-check, no Cloudflare in the
 * blast radius, and the consumer lives beside the relay that wrote the rows it updates.
 *
 * MATCHING is by SES `mail.messageId` exactly — the value the SES provider returns at
 * acceptance and the relay persists in the same transaction that marks the row `sent`
 * (migration 0126). Address-plus-time would misattribute a re-invite to the earlier
 * attempt; the id cannot. An event whose id matches no row is LOGGED and dropped: rows
 * sent before 0126 carry no id, and re-invites retire their predecessors' tokens anyway.
 *
 * IDEMPOTENT BY CONSTRUCTION: SQS at-least-once delivery means the same event can arrive
 * twice. The update is a guarded no-op in that case — `WHERE status = 'sent'` refuses to
 * touch a row already marked `bounced`/`complained`, and both writes carry the same
 * verdict, so a duplicate changes nothing.
 *
 * OFF WHEN UNCONFIGURED: no `SES_BOUNCE_QUEUE_URL` → the consumer never starts and email
 * behaves exactly as before this service existed. That is the local-dev and
 * provider≠ses posture.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { eq, and } from 'drizzle-orm';
import { InjectDrizzle, Span, AppConfigService } from '@platform';
import { withJobContext } from '@qnsc-vn/observability';
import type { DrizzleDB } from '@platform';
import { emailOutbox } from '../../../../db/schema/messaging';

/** The subset of an SES event notification this consumer reads. */
type SesEventNotification = {
  eventType?: string;
  mail?: { messageId?: string; destination?: string[] };
  bounce?: { bounceType?: string; diagnosticCode?: string };
  complaint?: { complaintSubType?: string | null; userAgent?: string | null };
};

/** The SNS envelope SES event destinations deliver inside the SQS message body. */
type SnsEnvelope = {
  Type?: string;
  MessageId?: string;
  Message?: string;
};

const POLL_INTERVAL_IDLE_MS = 20_000;

@Injectable()
export class BounceFeedbackService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BounceFeedbackService.name);
  private readonly sqs: SQSClient | null = null;
  private readonly queueUrl: string | undefined;
  private polling = false; // set, never read: one loop instance per process, kept for the debugger
  private stopped = false;

  constructor(
    @InjectDrizzle() private readonly db: DrizzleDB,
    config: AppConfigService,
  ) {
    this.queueUrl = (config.get('SES_BOUNCE_QUEUE_URL') ?? '').trim() || undefined;
    if (this.queueUrl) {
      // Deliberately created even when the configset is unset: the queue may already hold
      // verdicts from before a config change, and draining them is this service's job
      // regardless of whether new sends are being tagged.
      this.sqs = new SQSClient({
        region: config.get('AWS_REGION'),
        // LocalStack parity with every other AWS client in the app.
        ...(config.get('AWS_ENDPOINT_URL') ? { endpoint: config.get('AWS_ENDPOINT_URL') } : {}),
      });
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- lifecycle signature; the loop is fire-and-forget by design
  async onModuleInit(): Promise<void> {
    if (!this.queueUrl || !this.sqs) {
      this.logger.log('SES bounce feedback OFF — SES_BOUNCE_QUEUE_URL is not set');
      return;
    }
    this.polling = true;
    void this.loop();
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- a flag flip is all the stop the long-poll loop needs
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        const drained = await withJobContext('bounce-feedback', () => this.drainOnce());
        if (drained === 0) {
          await this.sleep(POLL_INTERVAL_IDLE_MS);
        }
        // Non-empty drain loops immediately: SQS long-poll returns as soon as a message
        // lands, so there is no separate wake signal to build.
      } catch (err) {
        this.logger.error({ err }, 'Bounce feedback drain failed — retrying after backoff');
        await this.sleep(POLL_INTERVAL_IDLE_MS);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * One long-poll batch. Returns the number of events processed (not the number of
   * rows updated — an event can legitimately match no row). Exported for the spec via
   * the public `drainOnceForTest` seam below.
   */
  @Span('email.bounceFeedback.drain')
  private async drainOnce(): Promise<number> {
    const response = await this.sqs!.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 10,
      }),
    );

    let processed = 0;
    for (const message of response.Messages ?? []) {
      try {
        await this.applyEvent(message.Body ?? '');
      } finally {
        // Deleted whether or not the event matched a row: an unmatched event can never
        // match a LATER row (its send already happened), so holding it would only poison
        // the queue against a retry loop that cannot succeed.
        if (message.ReceiptHandle) {
          await this.sqs!.send(
            new DeleteMessageCommand({
              QueueUrl: this.queueUrl,
              ReceiptHandle: message.ReceiptHandle,
            }),
          );
        }
      }
      processed += 1;
    }
    return processed;
  }

  /** Parse SNS → SES and apply the verdict. Visible for testing. */
  async applyEvent(rawBody: string): Promise<void> {
    let envelope: SnsEnvelope;
    try {
      envelope = JSON.parse(rawBody) as SnsEnvelope;
    } catch {
      this.logger.warn(
        { body: rawBody.slice(0, 200) },
        'Bounce feedback: non-JSON message dropped',
      );
      return;
    }

    // SNS SubscriptionConfirmation arrives on the queue before any event; the
    // infrastructure subscribes the queue out-of-band, so confirming here is out of
    // scope — acknowledging it as recognized-and-ignored stops it being logged as noise.
    if (envelope.Type === 'SubscriptionConfirmation') {
      this.logger.log('Bounce feedback: SNS subscription confirmation acknowledged');
      return;
    }

    let event: SesEventNotification;
    try {
      event = JSON.parse(envelope.Message ?? '{}') as SesEventNotification;
    } catch {
      this.logger.warn(
        { snsMessageId: envelope.MessageId },
        'Bounce feedback: SNS message with non-JSON payload dropped',
      );
      return;
    }

    if (event.eventType !== 'Bounce' && event.eventType !== 'Complaint') {
      // Delivery/Open/Click events can share the destination if the configset grows;
      // they carry no verdict this consumer records.
      return;
    }

    const messageId = event.mail?.messageId;
    if (!messageId) {
      this.logger.warn({ eventType: event.eventType }, 'Bounce feedback: event without messageId');
      return;
    }

    const status = event.eventType === 'Bounce' ? 'bounced' : 'complained';
    const diagnostic =
      event.eventType === 'Bounce'
        ? [event.bounce?.bounceType, event.bounce?.diagnosticCode].filter(Boolean).join(' — ')
        : 'recipient marked as spam';

    // Guarded by status = 'sent': at-least-once delivery makes duplicates ordinary, and
    // a verdict must never overwrite a DIFFERENT verdict (or a later resend's 'sent').
    const updated = await this.db
      .update(emailOutbox)
      .set({ status, feedbackAt: new Date(), lastError: diagnostic })
      .where(and(eq(emailOutbox.messageId, messageId), eq(emailOutbox.status, 'sent')))
      .returning({ id: emailOutbox.id, to: emailOutbox.to });

    if (updated.length === 0) {
      // Pre-0126 row (no id stored), an event for another configuration set, or a row a
      // duplicate already marked. All are expected; none are retryable.
      this.logger.log(
        { messageId, eventType: event.eventType },
        'Bounce feedback: event matched no sent row',
      );
      return;
    }

    this.logger.warn(
      { messageId, to: updated[0].to, status, diagnostic },
      'Email verdict received — row marked',
    );
  }
}
