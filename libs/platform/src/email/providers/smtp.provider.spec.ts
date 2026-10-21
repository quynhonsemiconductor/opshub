import { MailSendError, type EmailSender } from '@quynhonsemiconductor/platform-mail/sender';
import { describe, expect, it, vi } from 'vitest';
import { NonRetryableError } from '../../outbox/abstract-outbox-relay';
import type { EmailPayload } from '../email.provider';
import { SmtpEmailProvider } from './smtp.provider';

const payload: EmailPayload = {
  to: 'user@qnsc.vn',
  from: 'Mini Rova <noreply@qnsc.vn>',
  subject: 'Verify your email',
  html: '<p>Hello</p>',
  text: 'Hello',
  category: 'transactional',
  idempotencyKey: 'verify-1',
};

function harness(
  send: EmailSender['send'] = vi.fn().mockResolvedValue({ id: '<m@mailpit>', transport: 'smtp' }),
) {
  const makeSender = vi.fn((_env: Record<string, string | undefined>) => ({ send }));
  const provider = new SmtpEmailProvider(
    { host: 'localhost', port: 1120, from: 'noreply@qnsc.vn', nodeEnv: 'development' },
    makeSender,
  );
  return { provider, makeSender, send: send as unknown as ReturnType<typeof vi.fn> };
}

describe('SmtpEmailProvider', () => {
  it('builds the platform-mail smtp transport from its own config, not from the process environment', () => {
    const { provider, makeSender } = harness();
    provider.assertReady();
    expect(makeSender).toHaveBeenCalledWith({
      MAIL_TRANSPORT: 'smtp',
      MAIL_SMTP_HOST: 'localhost',
      MAIL_SMTP_PORT: '1120',
      MAIL_SMTP_FROM: 'noreply@qnsc.vn',
      NODE_ENV: 'development',
    });
  });

  it('sends the message and returns the relay id as the message id', async () => {
    const { provider, send } = harness();
    await expect(provider.send(payload)).resolves.toEqual({ messageId: '<m@mailpit>' });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'user@qnsc.vn',
        subject: 'Verify your email',
        text: 'Hello',
        category: 'transactional',
        idempotencyKey: 'verify-1',
      }),
      {},
    );
  });

  it('derives the text part from the HTML when the caller sent none', async () => {
    const { provider, send } = harness();
    await provider.send({ ...payload, text: undefined });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: ' Hello ' }), {});
  });

  it('refuses a message with no idempotency key before the transport is touched', async () => {
    const { provider, send } = harness();
    await expect(provider.send({ ...payload, idempotencyKey: '' })).rejects.toBeInstanceOf(
      NonRetryableError,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('dead-letters a refusal of the message itself', async () => {
    const { provider } = harness(
      vi
        .fn()
        .mockRejectedValue(new MailSendError('invalid_message', 'bad address', { status: 550 })),
    );
    await expect(provider.send(payload)).rejects.toBeInstanceOf(NonRetryableError);
  });

  it('leaves a transport failure to the relay to retry', async () => {
    const failure = new MailSendError('network', 'connection refused');
    const { provider } = harness(vi.fn().mockRejectedValue(failure));
    await expect(provider.send(payload)).rejects.toBe(failure);
  });
});
