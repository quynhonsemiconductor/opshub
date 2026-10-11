/**
 * What the SES provider actually puts on the wire.
 *
 * The interesting properties are all about the shape of the command, because that is where a mail
 * transport fails quietly. An unverified sender is refused outright by SES, but a missing plaintext
 * alternative, an unset configuration set or a dropped reply-to all send successfully and cost
 * something later — deliverability, attribution, or a reply nobody receives.
 *
 * The SDK client is stubbed rather than the module mocked: what matters is the exact command handed to
 * `send`, and a stub lets the assertions be about that.
 */
import { describe, expect, it, vi } from 'vitest';
import { SesEmailProvider } from './ses.provider';
import type { EmailPayload } from '../email.provider';

interface SentCommand {
  input: {
    FromEmailAddress?: string;
    ReplyToAddresses?: string[];
    ConfigurationSetName?: string;
    Destination?: { ToAddresses?: string[] };
    Content?: {
      Simple?: {
        Subject?: { Data?: string };
        Body?: { Html?: { Data?: string }; Text?: { Data?: string } };
      };
    };
  };
}

function makeProvider(configSet?: string, result: { MessageId?: string } = { MessageId: 'ses-1' }) {
  const send = vi.fn().mockResolvedValue(result);
  const provider = new SesEmailProvider('ap-southeast-1', configSet);
  // The client is built in the constructor; replacing it is the narrowest seam that keeps the
  // provider's own mapping under test.
  (provider as unknown as { ses: { send: typeof send } }).ses = { send };
  return { provider, send, sent: () => (send.mock.calls[0][0] as SentCommand).input };
}

const PAYLOAD: EmailPayload = {
  to: 'jane@example.com',
  from: 'OpsHub <ops@example.com>',
  subject: 'An asset was assigned to you',
  html: '<p>Hello</p>',
  text: 'Hello',
  category: 'transactional',
};

describe('SesEmailProvider', () => {
  it('sends to the recipient, from the configured sender', async () => {
    const { provider, sent } = makeProvider();
    await provider.send(PAYLOAD);

    expect(sent().FromEmailAddress).toBe('OpsHub <ops@example.com>');
    expect(sent().Destination?.ToAddresses).toEqual(['jane@example.com']);
    expect(sent().Content?.Simple?.Subject?.Data).toBe('An asset was assigned to you');
  });

  it('pairs HTML with plaintext, because a filter scores a body without one lower', async () => {
    const { provider, sent } = makeProvider();
    await provider.send(PAYLOAD);

    expect(sent().Content?.Simple?.Body?.Html?.Data).toBe('<p>Hello</p>');
    expect(sent().Content?.Simple?.Body?.Text?.Data).toBe('Hello');
  });

  it('omits the text part rather than sending an empty one', async () => {
    // `Text: { Data: '' }` is a plaintext alternative that says nothing, which reads worse to a filter
    // than no alternative at all. Every template here produces both, so this is the defensive branch.
    const { provider, sent } = makeProvider();
    await provider.send({ ...PAYLOAD, text: undefined });

    expect(sent().Content?.Simple?.Body?.Text).toBeUndefined();
  });

  it('refuses to send with no sender rather than inventing one', async () => {
    /*
     * The same refusal the Resend provider makes, and for the same reason: a default sender pointing at
     * a domain the deployment may not own does not fail, it sends from an address that fails SPF and
     * DKIM at the far end. SES would reject an unverified identity anyway — but with a message about
     * the identity, not about the variable somebody forgot.
     */
    const { provider, send } = makeProvider();

    await expect(provider.send({ ...PAYLOAD, from: undefined })).rejects.toThrow(/MAIL_FROM_EMAIL/);
    expect(send, 'it contacted SES before refusing').not.toHaveBeenCalled();
  });

  it('passes a reply-to through when there is one', async () => {
    const { provider, sent } = makeProvider();
    await provider.send({ ...PAYLOAD, replyTo: 'people@example.com' });
    expect(sent().ReplyToAddresses).toEqual(['people@example.com']);
  });

  it('omits ReplyToAddresses entirely when there is none', async () => {
    // Not an empty array: SES treats `ReplyToAddresses: []` as a supplied-and-empty list, and the
    // header it produces is not the same as no header.
    const { provider, sent } = makeProvider();
    await provider.send(PAYLOAD);
    expect(sent().ReplyToAddresses).toBeUndefined();
  });

  it('tags the send with the configuration set when one is configured', async () => {
    // This is what makes a later bounce attributable to this message. Without it the event arrives and
    // nothing can say which send caused it.
    const { provider, sent } = makeProvider('opshub-bounces');
    await provider.send(PAYLOAD);
    expect(sent().ConfigurationSetName).toBe('opshub-bounces');
  });

  it('omits the configuration set when none is configured', async () => {
    // Sends must work without one — an empty `ConfigurationSetName` is an error from SES, not a no-op.
    const { provider, sent } = makeProvider(undefined);
    await provider.send(PAYLOAD);
    expect(sent().ConfigurationSetName).toBeUndefined();
  });

  it('ignores an idempotency key, because SES has no such parameter', async () => {
    /*
     * Recorded rather than left to be discovered. Resend honours a key and SES has none, so the outbox's
     * own `idempotency_key` with its partial unique index is the mechanism — the provider-level key was
     * defence in depth on one transport, never the guarantee. What must not happen is the key leaking
     * into the command as an unrecognised field.
     */
    const { provider, sent } = makeProvider();
    await provider.send({ ...PAYLOAD, idempotencyKey: 'notification:42' });

    expect(JSON.stringify(sent())).not.toContain('notification:42');
  });

  it('rethrows a send failure so the relay can retry it', async () => {
    /*
     * The relay counts attempts and dead-letters on the failure path, so swallowing an error here would
     * mark the row sent and lose the mail. `AccessDenied` is the shape this matters most for: it is what
     * a missing `ses:SendEmail` grant produces on every send.
     */
    const send = vi.fn().mockRejectedValue(new Error('AccessDenied'));
    const provider = new SesEmailProvider('ap-southeast-1');
    (provider as unknown as { ses: { send: typeof send } }).ses = { send };

    await expect(provider.send(PAYLOAD)).rejects.toThrow('AccessDenied');
  });

  it('bounds the WHOLE send, SDK retries included, with an abort signal', async () => {
    /*
     * Without a deadline the SDK retries up to three times with no overall bound, past the email relay's
     * lease: another relay can then repeat the send, and the reaper can dead-letter a row that is still
     * being delivered.
     */
    const { provider, send } = makeProvider();
    await provider.send(PAYLOAD);

    const options = send.mock.calls[0][1] as { abortSignal: AbortSignal };
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
    expect(options.abortSignal.aborted).toBe(false);
  });
});
