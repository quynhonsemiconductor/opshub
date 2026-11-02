import { describe, expect, it } from 'vitest';
import { SENDER_BLOCKED_FIELD } from './providers/graph.provider';

/**
 * The Graph provider logs `senderBlocked` (SENDER_BLOCKED_FIELD in providers/graph.provider.ts) when Microsoft refuses the shared mailbox. The email
 * relay then DEFERS every row without spending its attempts, so `outbox-dead-letter` never fires while no email leaves: this log field is the only signal.
 * The alarm is worthless if the field drifts away from the pattern, so the name is pinned here (the alert lives in gitops).
 */
describe('the email-sender-blocked alarm', () => {
  it('keeps the field name the alert filters on', () => {
    expect(SENDER_BLOCKED_FIELD).toBe('senderBlocked');
  });
});
