import { Logger } from '@nestjs/common';
import {
  MailSendError,
  createEmailSender,
  type EmailSender,
  type MailEnv,
} from '@quynhonsemiconductor/platform-mail/sender';
import { NonRetryableError } from '../../outbox/abstract-outbox-relay';
import type {
  EmailPayload,
  EmailSendOptions,
  EmailSendResult,
  IEmailProvider,
} from '../email.provider';

/** What the SMTP transport is configured with. Every field comes from the validated environment. */
export interface SmtpMailConfig {
  /** The relay's host: Mailpit's compose service name in a container, `localhost` on the host. */
  host: string;
  port: number;
  /** The bare envelope sender (`MAIL_FROM_EMAIL`). The display name on `payload.from` is not sent: SMTP takes a bare address. */
  from: string;
  nodeEnv: string;
}

/**
 * Sends through a plain SMTP relay. DEVELOPMENT ONLY: Mailpit, which accepts any message and keeps it for the UI and the check command.
 *
 * `@quynhonsemiconductor/platform-mail` refuses this transport when NODE_ENV=production (its smtp-guard), and env.schema refuses
 * EMAIL_PROVIDER=smtp there first, so a copied value fails at boot instead of sending through an unauthenticated relay.
 *
 * Retries belong to the relay, as for every provider here: a connection failure or a 4xx reply is retryable and is rethrown; a 5xx
 * refusal of this message is not, and is dead-lettered at once.
 */
export class SmtpEmailProvider implements IEmailProvider {
  private readonly logger = new Logger(SmtpEmailProvider.name);
  private sender: EmailSender | undefined;

  constructor(
    private readonly config: SmtpMailConfig,
    /** Test seam: replaces the real transport. */
    private readonly makeSender: (env: MailEnv) => EmailSender = (env) =>
      createEmailSender({ env }),
  ) {}

  /** Builds the transport now, throwing `MailConfigError` (naming the variable) if the environment cannot support it. */
  assertReady(): void {
    this.transport();
  }

  async send(payload: EmailPayload, options: EmailSendOptions = {}): Promise<EmailSendResult> {
    const { idempotencyKey } = payload;
    if (!idempotencyKey) {
      // EmailService always supplies one; a caller that does not has a bug the transport would reject as invalid anyway.
      throw new NonRetryableError('SMTP mail: no idempotency key on the message.');
    }
    try {
      const result = await this.transport().send(
        {
          to: payload.to,
          ...(payload.replyTo ? { replyTo: payload.replyTo } : {}),
          subject: payload.subject,
          html: payload.html,
          // A caller may send no text part: the HTML with its tags removed is the fallback.
          text: payload.text ?? payload.html.replace(/<[^>]+>/g, ' '),
          category: payload.category ?? 'transactional',
          idempotencyKey,
        },
        options.signal ? { signal: options.signal } : {},
      );
      this.logger.log(
        { to: payload.to, subject: payload.subject, transport: result.transport },
        'Email sent via SMTP relay',
      );
      return { messageId: result.id };
    } catch (err) {
      throw this.classify(err);
    }
  }

  private transport(): EmailSender {
    if (!this.sender) {
      const { host, port, from, nodeEnv } = this.config;
      this.sender = this.makeSender({
        MAIL_TRANSPORT: 'smtp',
        MAIL_SMTP_HOST: host,
        MAIL_SMTP_PORT: String(port),
        MAIL_SMTP_FROM: from,
        NODE_ENV: nodeEnv,
      });
    }
    return this.sender;
  }

  /** Only a refusal of THIS message is final. Anything else (connection, timeout, a 4xx) is left for the relay to retry. */
  private classify(err: unknown): unknown {
    if (!(err instanceof MailSendError)) return err;
    this.logger.error({ code: err.code, status: err.status }, 'SMTP send failed');
    if (!err.retryable) return new NonRetryableError(err.message, { cause: err });
    return err;
  }
}
