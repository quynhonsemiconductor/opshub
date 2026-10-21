export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER');

/**
 * The longest one provider send may take, retries included.
 *
 * The email relay hides a claimed row for a lease (see AbstractOutboxRelay). A send still in flight after
 * the lease lapsed is a send another relay may repeat, and a row the reaper dead-letters while it is
 * still being delivered. So the send has a hard deadline and the relay's lease is derived from it
 * (`EmailRelayService.leaseMsFor`), with a margin. Graph CANCELS the request at the deadline (`abortSignal`).
 */
export const EMAIL_SEND_TIMEOUT_MS = 30_000;

/**
 * What a provider hands back at acceptance. `messageId` is the transport's id for the
 * send. NULL for providers without an id (dev). ACCEPTED is not DELIVERED: the relay stores
 * this id at acceptance, and a later verdict (if one is ever read) is matched on it.
 */
export interface EmailSendResult {
  messageId: string | null;
}

export type EmailCategory = 'transactional' | 'notification' | 'marketing';

export interface EmailPayload {
  to: string;
  replyTo?: string;
  subject: string;
  html: string;
  text?: string;
  category?: EmailCategory;
  idempotencyKey?: string;
}

/** What the caller can hand a send besides the message. */
export interface EmailSendOptions {
  /**
   * Aborted when the caller's deadline (EMAIL_SEND_TIMEOUT_MS) passes. A provider that can cancel (Graph) cancels the request, its in-place
   * retries and any wait.
   */
  signal?: AbortSignal;
}

export interface IEmailProvider {
  send(payload: EmailPayload, options?: EmailSendOptions): Promise<EmailSendResult>;
}
