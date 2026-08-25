import { Injectable, Logger } from '@nestjs/common';
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import type { EmailPayload, EmailSendResult, IEmailProvider } from '../email.provider';

/**
 * AWS SES transport, on the v2 API.
 *
 * WHY SES AND NOT RESEND. Resend needs an account, a key in a secret, and a third party in the
 * delivery path for mail this product already has the AWS identity to send itself. SES is in the same
 * account as everything else, authenticates with the task role rather than a stored key, and is what
 * the sibling repo settled on for those reasons.
 *
 * WHY sesv2 AND NOT `client-ses`: `SendEmailCommand` here carries `ConfigurationSetName` and returns
 * `MessageId` as a first-class field. This product does not consume bounce feedback yet, so the id is
 * logged rather than stored — but the version that cannot report it forecloses doing so later, and the
 * two clients are otherwise the same call.
 *
 * WHAT SES CANNOT DO that Resend can: there is no idempotency key on the API. `payload.idempotencyKey`
 * is therefore ignored here, and that is safe because it was never the guarantee — `email_outbox` has
 * its own `idempotency_key` with a partial unique index, so a duplicate is refused before a provider is
 * reached. The provider-level key was defence in depth on one transport, not the mechanism.
 *
 * SENDING NEEDS AN IAM GRANT, and its absence does not look like a mail problem. Without
 * `ses:SendEmail` on the task role every send fails `AccessDenied` before the sender is even examined,
 * the relay's retries exhaust, and the API goes on reporting healthy — the sibling repo ran both of its
 * environments that way with `EMAIL_PROVIDER=ses` and a correct sender sitting beside it. The grant
 * ships with this change, scoped to the sender's own domain identity and pinned to the exact from
 * address.
 */
@Injectable()
export class SesEmailProvider implements IEmailProvider {
  private readonly logger = new Logger(SesEmailProvider.name);
  private readonly ses: SESv2Client;

  constructor(
    region: string,
    /**
     * The SES configuration set, when one exists.
     *
     * Tagging a send with it is what makes bounce and complaint events attributable to the message
     * later. Optional because sends work without one; what does not work is finding out afterwards
     * which address rejected the mail.
     */
    private readonly configurationSetName?: string,
  ) {
    this.ses = new SESv2Client({ region });
  }

  async send(payload: EmailPayload): Promise<EmailSendResult> {
    if (!payload.from) {
      /*
       * NO HARD-CODED FALLBACK SENDER, for the same reason the Resend provider refuses one: a default
       * pointing at a domain this deployment may not own does not fail, it sends from an address that
       * fails SPF and DKIM at the receiving end. That is silent non-delivery or delivery to spam, and
       * nothing in our logs explains either.
       *
       * With SES it fails LOUDER than that — an unverified identity is rejected outright — but the
       * message would name the wrong problem, so the refusal stays here where it can name the variable.
       */
      throw new Error('SES: no sender address configured (MAIL_FROM_EMAIL)');
    }

    try {
      const result = await this.ses.send(
        new SendEmailCommand({
          FromEmailAddress: payload.from,
          Destination: { ToAddresses: [payload.to] },
          ...(payload.replyTo ? { ReplyToAddresses: [payload.replyTo] } : {}),
          ...(this.configurationSetName ? { ConfigurationSetName: this.configurationSetName } : {}),
          Content: {
            Simple: {
              Subject: { Data: payload.subject, Charset: 'UTF-8' },
              Body: {
                Html: { Data: payload.html, Charset: 'UTF-8' },
                // HTML AND TEXT ALWAYS PAIRED. A body with no plaintext alternative scores worse with
                // every major filter, and the templates already produce both.
                ...(payload.text ? { Text: { Data: payload.text, Charset: 'UTF-8' } } : {}),
              },
            },
          },
        }),
      );

      /*
       * ACCEPTED, NOT DELIVERED, and the log says so. SES answers as soon as it has taken the message;
       * the receiving server may still refuse it minutes later. Logging this as "sent" is how a bounce
       * rate goes unnoticed — the id is what a future feedback consumer would match that verdict on.
       */
      this.logger.log(
        { to: payload.to, subject: payload.subject, messageId: result.MessageId ?? null },
        'Email accepted by SES',
      );

      // ACCEPTED, NOT DELIVERED — and the id is the feedback loop's only exact match key
      // for the verdict that may arrive minutes later (BounceFeedbackService matches on
      // it). Returned so the relay can persist it in the same write that marks the row sent.
      return { messageId: result.MessageId ?? null };
    } catch (err) {
      this.logger.error({ err, to: payload.to, subject: payload.subject }, 'SES send failed');
      throw err;
    }
  }
}
