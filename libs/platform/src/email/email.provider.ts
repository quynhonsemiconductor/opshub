export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER');

/**
 * The longest one provider send may take, retries included.
 *
 * The email relay hides a claimed row for a lease (see AbstractOutboxRelay). A send still in flight after
 * the lease lapsed is a send another relay may repeat, and a row the reaper dead-letters while it is
 * still being delivered. So the send has a hard deadline and the relay's lease is derived from it
 * (`EmailRelayService.leaseMsFor`), with a margin. SES also CANCELS the request at the deadline
 * (`abortSignal`); the Resend SDK has no cancel, so there the wait is bounded and the provider's
 * idempotency key (the outbox row id) makes a late arrival harmless.
 */
export const EMAIL_SEND_TIMEOUT_MS = 30_000;

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
