import { Logger } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import {
  MailSendError,
  createEmailSender,
  type EmailSender,
  type MailEnv,
} from '@quynhonsemiconductor/platform-mail/sender';
import { DeferError, NonRetryableError, RetryAfterError } from '../../outbox/abstract-outbox-relay';
import type {
  EmailPayload,
  EmailSendOptions,
  EmailSendResult,
  IEmailProvider,
} from '../email.provider';

/** What the Graph transport is configured with. Every field comes from the worker's validated environment. */
export interface GraphMailConfig {
  /** The environment's shared mailbox (`noreply-opshub-dev@qnsc.vn` in develop, `noreply-opshub@qnsc.vn` in production). Messages go out as this mailbox and no other. */
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
 * How long the provider refuses to call Graph after it was told the SENDER is wrong (403/404 on `sendMail`), and how long the relay defers the
 * rows. A new Exchange role assignment can take up to ~2 hours to propagate and a mailbox can be missing or not yet REST-enabled; none of that is
 * a problem with a message, and every row in the queue will fail the same way until it is fixed.
 */
export const SENDER_BLOCKED_BACKOFF_MS = 15 * 60_000;

/** Counted once per block; an alarm (`email-sender-blocked`) watches it. `reason` is `forbidden` or `mailbox_not_found`: a closed set. */
const senderBlocked = metrics.getMeter('opshub-worker').createCounter('email.sender_blocked', {
  description:
    'Graph refused the sender mailbox (403/404 on sendMail): the Exchange role or the mailbox is wrong',
});

/**
 * Sends through Microsoft Graph `sendMail` from the product's shared mailbox, using `@quynhonsemiconductor/platform-mail`'s transport.
 *
 * WHY ONLY THE TRANSPORT (`/sender`), NOT THE `mail.send` QUEUE: this product has its own outbox, relay, retry and dead-letter handling
 * (`email_outbox`, `EmailRelayService`). The queue would be a second one. The relay claims a row before it calls `send`, so a row is sent once
 * per claim; Graph has no idempotency key, so a send that outlives its caller's deadline could still duplicate. THE CALLER'S DEADLINE THEREFORE
 * REACHES THE TRANSPORT (`options.signal`): when it fires, the request, the in-place retries and any `Retry-After` wait all stop, so a late 202
 * cannot arrive after the relay has already retried the row.
 *
 * WHAT IS A MESSAGE PROBLEM AND WHAT IS NOT. 400 (invalid) and 413 (too large) are about THIS message: the row is dead-lettered at once. A 403 or
 * 404 on `sendMail` is about the SENDER (the Exchange role is not assigned yet or is still propagating, the mailbox is missing or not REST-enabled):
 * it would dead-letter every queued row at rollout for a cause unrelated to any of them. So it BLOCKS the sender: this row and every row that
 * follows are deferred (attempt refunded) for {@link SENDER_BLOCKED_BACKOFF_MS} without calling Graph, one error is logged with
 * `senderBlocked`, and `email.sender_blocked` is counted for the alarm.
 *
 * AUTH: the credential is built lazily on the FIRST send. The API process shares this module and never sends (it only writes outbox rows), and it
 * is deliberately given no Graph credential; constructing the sender eagerly would crash it at boot. The WORKER fails fast instead:
 * `assertReady()` is called when the email relay starts, so a missing variable stops the deploy rather than blocking the first invitation.
 *
 * The `from` the service passes (a display name and an address) is IGNORED: the transport refuses any sender but the configured mailbox, and its
 * display name is the mailbox's own. Marketing is refused: M365 is not for bulk or marketing mail (HYBRID-INFRA-PLAN §7.4).
 */
export class GraphEmailProvider implements IEmailProvider {
  /** The provider owns its retries (the transport, bounded by the caller's deadline, and the relay's backoff): no wrapper may retry it again. */
  readonly ownsRetries = true;

  private readonly logger = new Logger(GraphEmailProvider.name);
  private sender: EmailSender | undefined;
  private blockedUntil = 0;
  private blockedReason: 'forbidden' | 'mailbox_not_found' | undefined;

  constructor(
    private readonly config: GraphMailConfig,
    /** Test seam: replaces the real transport. */
    private readonly makeSender: (env: MailEnv) => EmailSender = (env) =>
      createEmailSender({ env }),
    /** Test seam. */
    private readonly now: () => number = Date.now,
  ) {}

  /** Builds the transport now, throwing `MailConfigError` (naming the variable) if the environment cannot support it. */
  assertReady(): void {
    this.transport();
  }

  async send(payload: EmailPayload, options: EmailSendOptions = {}): Promise<EmailSendResult> {
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

    const remaining = this.blockedUntil - this.now();
    if (remaining > 0) {
      // Do not even ask Graph: it said no a moment ago, and every row would earn the same answer.
      throw new DeferError(
        `Graph sender is blocked (${this.blockedReason ?? 'forbidden'}); deferred`,
        remaining,
      );
    }

    try {
      const result = await this.transport().send(
        {
          to: payload.to,
          ...(payload.replyTo ? { replyTo: payload.replyTo } : {}),
          subject: payload.subject,
          html: payload.html,
          text: payload.text ?? htmlToText(payload.html),
          category,
          idempotencyKey: payload.idempotencyKey,
        },
        options.signal ? { signal: options.signal } : {},
      );
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
   * The relay's decision, from the transport's closed error codes. The error text holds the code, the status and Microsoft's request id, never a
   * recipient or a body.
   *
   *  - `forbidden` / `mailbox_not_found` (403 / 404 on sendMail): the SENDER is wrong. Block it, defer, alarm; never dead-letter a message for it.
   *  - `invalid_message` / `too_large` (400 / 413) and `config`: about this message or this process; they fail the same way every time:
   *    dead-letter now (the `outbox-dead-letter` alarm fires).
   *  - 429 carries the server's own wait; everything else (401, 5xx, timeout, network) is retried by the relay with backoff.
   */
  private classify(err: unknown): unknown {
    if (!(err instanceof MailSendError)) return err;
    this.logger.error(
      { code: err.code, status: err.status, requestId: err.requestId },
      'Graph sendMail failed',
    );
    if (err.code === 'forbidden' || err.code === 'mailbox_not_found') {
      this.blockedUntil = this.now() + SENDER_BLOCKED_BACKOFF_MS;
      this.blockedReason = err.code;
      senderBlocked.add(1, { reason: err.code });
      this.logger.error(
        { senderBlocked: err.code, status: err.status, requestId: err.requestId },
        `Graph refused the sender mailbox (${err.code}): the Exchange role or the mailbox is wrong. Rows are deferred ${SENDER_BLOCKED_BACKOFF_MS / 60_000} minutes; see docs/runbooks/mail-graph.md`,
      );
      return new DeferError(err.message, SENDER_BLOCKED_BACKOFF_MS);
    }
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
