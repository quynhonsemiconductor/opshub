import { Injectable, Logger } from '@nestjs/common';
import { Resend } from 'resend';
import { type IEmailProvider, type EmailPayload, type EmailSendResult } from '../email.provider';

/**
 * Resend email provider — uses the official Resend SDK.
 * Injects the Resend client rather than creating it internally so it can be
 * swapped in tests without monkey-patching.
 *
 * IDEMPOTENCY GOES THROUGH THE SDK, not a header of our own. This used to set
 * `headers: { 'X-Idempotency-Key': … }`, which Resend does not read — so its native de-duplication
 * never engaged and the one window the outbox cannot close was wide open: a provider call that
 * succeeds and whose transaction then fails to commit leaves the row `pending`, and the retry sends a
 * second real email. The SDK's `idempotencyKey` option is sent as the `Idempotency-Key` header Resend
 * actually honours, which collapses that retry into the original send.
 */
@Injectable()
export class ResendEmailProvider implements IEmailProvider {
  private readonly logger = new Logger(ResendEmailProvider.name);
  private readonly client: Resend;

  constructor(apiKey: string) {
    this.client = new Resend(apiKey);
  }

  async send(payload: EmailPayload): Promise<EmailSendResult> {
    if (!payload.from) {
      /*
       * NO HARD-CODED FALLBACK SENDER. This used to default to `OpsHub <no-reply@opshub.app>`, a
       * domain this deployment may not own — so a misconfigured environment did not fail, it sent
       * from an address that fails SPF/DKIM at the receiving end. Silent non-delivery, or delivery
       * straight to spam, and either way nothing in our logs says why.
       *
       * `EmailService` always supplies `from` from configuration, and the env schema now refuses to
       * boot a non-dev provider without a sender. This is the third line of defence and it throws
       * rather than guessing.
       */
      throw new Error('Resend: no sender address configured (MAIL_FROM_EMAIL)');
    }

    const { data, error } = await this.client.emails.send(
      {
        from: payload.from,
        to: [payload.to],
        replyTo: payload.replyTo,
        subject: payload.subject,
        html: payload.html,
        text: payload.text,
        tags: payload.category ? [{ name: 'category', value: payload.category }] : undefined,
      },
      // The SDK turns this into the `Idempotency-Key` header. Omitted entirely when absent rather
      // than passed as undefined, so a caller with no key gets the plain request.
      payload.idempotencyKey ? { idempotencyKey: payload.idempotencyKey } : undefined,
    );

    if (error) {
      this.logger.error({ error, to: payload.to }, 'Resend delivery failed');
      throw new Error(`Resend: ${error.message}`);
    }

    // Resend's id is what its webhook events carry; no webhook is wired here, but
    // returning it costs nothing and keeps the provider contract uniform.
    return { messageId: data?.id ?? null };
  }
}
