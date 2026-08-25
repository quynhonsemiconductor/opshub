export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER');

/**
 * What a provider hands back at acceptance. `messageId` is the transport's id for the
 * send — SES echoes it in every asynchronous bounce/complaint event, which makes it the
 * only exact match key between a verdict and the outbox row that earned it. NULL for
 * providers without an id (dev). ACCEPTED is not DELIVERED: SES answers 200 before the
 * receiving mail server has said anything, so the relay stores this id and the feedback
 * loop writes the verdict that may arrive minutes later.
 */
export interface EmailSendResult {
  messageId: string | null;
}

export type EmailCategory = 'transactional' | 'notification' | 'marketing';

export interface EmailPayload {
  to: string;
  from?: string;
  replyTo?: string;
  subject: string;
  html: string;
  text?: string;
  category?: EmailCategory;
  idempotencyKey?: string;
}

export interface IEmailProvider {
  send(payload: EmailPayload): Promise<EmailSendResult>;
}
