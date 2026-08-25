import { Injectable, Logger } from '@nestjs/common';
import { type IEmailProvider, type EmailPayload, type EmailSendResult } from '../email.provider';

/**
 * Dev email provider — prints emails to the logger instead of sending them.
 * Used in development and test environments.
 */
@Injectable()
export class DevEmailProvider implements IEmailProvider {
  private readonly logger = new Logger(DevEmailProvider.name);

  // eslint-disable-next-line @typescript-eslint/require-await
  async send(payload: EmailPayload): Promise<EmailSendResult> {
    this.logger.log(
      {
        to: payload.to,
        subject: payload.subject,
        category: payload.category ?? 'transactional',
        preview: payload.text?.slice(0, 120),
      },
      '[DEV] Email would be sent',
    );

    return { messageId: null };
  }
}
