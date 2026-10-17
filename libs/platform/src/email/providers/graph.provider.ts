import { Logger } from '@nestjs/common';
import {
  MailSendError,
  createEmailSender,
  type EmailSender,
  type MailEnv,
} from '@quynhonsemiconductor/platform-mail/sender';
import { NonRetryableError, RetryAfterError } from '../../outbox/abstract-outbox-relay';
import type { EmailPayload, EmailSendResult, IEmailProvider } from '../email.provider';

/** What the Graph transport is configured with. Every field comes from the worker's validated environment. */
export interface GraphMailConfig {
  /** The product's shared mailbox, `noreply-<product>@qnsc.vn`. Messages go out as this mailbox and no other. */
  sender: string;
  tenantId: string | undefined;
  /** The Entra app that holds the Exchange `Application Mail.Send` role for that mailbox (no Graph permission in Entra). */
  clientId: string | undefined;
  /** PEM, key + certificate (ECS). */
  certificate: string | undefined;
  /** Projected ServiceAccount token (k3s). Wins over the certificate, so the move is adding this and deleting the certificate. */
  federatedTokenFile: string | undefined;
  nodeEnv: string;
}

/**
 * Sends through Microsoft Graph `sendMail` from the product's shared mailbox, using `@quynhonsemiconductor/platform-mail`'s transport.
 *
 * WHY ONLY THE TRANSPORT (`/sender`), NOT THE `mail.send` QUEUE: this product has its own outbox, relay, retry and dead-letter handling
 * (`email_outbox`, `EmailRelayService`). The queue would be a second one. What the package contributes is the part that is easy to get wrong:
 * the Graph request, the credential, validation, and a closed set of error codes. The relay claims a row before it calls `send`, so a row is sent
 * once per claim; Graph has no idempotency key, so a lease that lapses mid-send can still duplicate (the same at-least-once the SES path had).
 *
 * AUTH: the credential is built lazily on the FIRST send. The API process shares this module and never sends (it only writes outbox rows), and
 * it is deliberately given no Graph credential (`ApiEnvSchema` refuses GRAPH_*); constructing the sender eagerly would crash it at boot.
 * The WORKER fails fast instead: `assertReady()` is called when the email relay starts, so a missing variable stops the deploy rather than
 * dead-lettering the first invitation.
 *
 * The `from` the service passes (a display name and an address) is IGNORED: the transport refuses any sender but the configured mailbox, and its
 * display name is the mailbox's own. Marketing is refused: M365 is not for bulk or marketing mail (HYBRID-INFRA-PLAN §7.4).
 */
export class GraphEmailProvider implements IEmailProvider {
  private readonly logger = new Logger(GraphEmailProvider.name);
  private sender: EmailSender | undefined;

  constructor(
    private readonly config: GraphMailConfig,
    /** Test seam: replaces the real transport. */
    private readonly makeSender: (env: MailEnv) => EmailSender = (env) =>
      createEmailSender({ env }),
  ) {}

  /** Builds the transport now, throwing `MailConfigError` (naming the variable) if the environment cannot support it. */
  assertReady(): void {
    this.transport();
  }

  async send(payload: EmailPayload): Promise<EmailSendResult> {
    const category = payload.category ?? 'transactional';
    if (category === 'marketing') {
      throw new NonRetryableError(
        'Marketing email is not sent through Microsoft 365 (Graph). Use a bulk-mail service for it.',
      );
    }
    if (!payload.idempotencyKey) {
      // EmailService always supplies one; a caller that does not has a bug the transport would reject as invalid_message anyway.
      throw new NonRetryableError('Graph mail: no idempotency key on the message.');
    }

    try {
      const result = await this.transport().send({
        to: payload.to,
        ...(payload.replyTo ? { replyTo: payload.replyTo } : {}),
        subject: payload.subject,
        html: payload.html,
        text: payload.text ?? htmlToText(payload.html),
        category,
        idempotencyKey: payload.idempotencyKey,
      });
      this.logger.log(
        { to: payload.to, subject: payload.subject, category, transport: result.transport },
        'Email sent via Microsoft Graph',
      );
      return { messageId: result.id };
    } catch (err) {
      throw this.classify(err);
    }
  }

  private transport(): EmailSender {
    if (!this.sender) {
      const { sender, tenantId, clientId, certificate, federatedTokenFile, nodeEnv } = this.config;
      this.sender = this.makeSender({
        MAIL_TRANSPORT: 'graph',
        MAIL_GRAPH_SENDER: sender,
        NODE_ENV: nodeEnv,
        ...(tenantId ? { AZURE_TENANT_ID: tenantId } : {}),
        ...(clientId ? { AZURE_CLIENT_ID: clientId } : {}),
        ...(certificate ? { AZURE_CLIENT_CERTIFICATE: certificate } : {}),
        ...(federatedTokenFile ? { AZURE_FEDERATED_TOKEN_FILE: federatedTokenFile } : {}),
      });
    }
    return this.sender;
  }

  /**
   * The relay's retry decision, from the transport's closed error codes. A 400/403/404/413 will fail the same way on every retry, so the row is
   * dead-lettered now (and the `outbox-dead-letter` alarm fires); a 429 carries the server's own wait; everything else is retried with backoff.
   * The error text holds the code, the status and Microsoft's request id, never a recipient or a body.
   */
  private classify(err: unknown): unknown {
    if (!(err instanceof MailSendError)) return err;
    this.logger.error(
      { code: err.code, status: err.status, requestId: err.requestId },
      'Graph sendMail failed',
    );
    if (!err.retryable) return new NonRetryableError(err.message, { cause: err });
    if (err.retryAfterSeconds !== undefined) {
      return new RetryAfterError(err.message, err.retryAfterSeconds * 1000);
    }
    return err;
  }
}

/** A plain-text alternative when a template supplied none: tags removed, entities for the common cases, whitespace collapsed. */
function htmlToText(html: string): string {
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*/g, '\n\n')
    .trim();
  return text === '' ? ' ' : text;
}
