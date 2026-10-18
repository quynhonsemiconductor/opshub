import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SENDER_BLOCKED_FIELD } from './providers/graph.provider';

/**
 * The Graph provider logs `senderBlocked` (SENDER_BLOCKED_FIELD in providers/graph.provider.ts) when Microsoft refuses the shared mailbox. The email
 * relay then DEFERS every row without spending its attempts, so `outbox-dead-letter` never fires while no email leaves: this log field is the only signal.
 * The alarm is worthless if the field drifts away from the pattern, so some Terraform must filter on exactly that name.
 */
describe('the email-sender-blocked alarm', () => {
  it('filters on the field the Graph provider logs', () => {
    expect(SENDER_BLOCKED_FIELD).toBe('senderBlocked');
    const infra = join(__dirname, '../../../..', 'infra');
    // --exclude-dir is not optional: .terraform holds cached provider binaries and module copies.
    const terraform = execFileSync(
      'grep',
      ['-rl', '--include=*.tf', '--exclude-dir=.terraform', `$.${SENDER_BLOCKED_FIELD}`, infra],
      { encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean);
    expect(
      terraform,
      `No Terraform under infra/ filters on ${SENDER_BLOCKED_FIELD}: a refused mailbox would stop all email with nothing alarming.`,
    ).not.toEqual([]);
  });
});
