import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  MailConfigError,
  MailSendError,
  type EmailMessage,
  type EmailSender,
} from '@quynhonsemiconductor/platform-mail/sender';
import { NonRetryableError, RetryAfterError } from '../../outbox/abstract-outbox-relay';
import { GraphEmailProvider, type GraphMailConfig } from './graph.provider';

const CONFIG: GraphMailConfig = {
  sender: 'noreply-opshub@qnsc.vn',
  tenantId: '11111111-1111-1111-1111-111111111111',
  clientId: '22222222-2222-2222-2222-222222222222',
  certificate: undefined,
  federatedTokenFile: undefined,
  nodeEnv: 'production',
};

const PAYLOAD = {
  to: 'someone@qnsc.vn',
  from: '"OpsHub" <opshub-noreply@qnsc.vn>',
  subject: 'Approve the request',
  html: '<p>Hello &amp; welcome</p><p>Second</p>',
  text: 'Hello & welcome',
  category: 'transactional' as const,
  idempotencyKey: 'email-outbox:row-1',
};

function fakeSender(send: (m: EmailMessage) => Promise<{ id: string; transport: 'graph' }>) {
  const spy = vi.fn(send);
  const sender = { mailbox: 'noreply-opshub@qnsc.vn', send: spy } as unknown as EmailSender;
  return { sender, send: spy };
}

describe('GraphEmailProvider', () => {
  it('sends the message through the transport as the mailbox, ignoring the display-name `from` the service builds', async () => {
    const { sender, send } = fakeSender(() => Promise.resolve({ id: 'req-1', transport: 'graph' }));
    const provider = new GraphEmailProvider(CONFIG, () => sender);

    const result = await provider.send({ ...PAYLOAD, replyTo: 'help@qnsc.vn' });

    expect(result).toEqual({ messageId: 'req-1' });
    const message = send.mock.calls[0][0];
    expect(message).toEqual({
      to: 'someone@qnsc.vn',
      replyTo: 'help@qnsc.vn',
      subject: 'Approve the request',
      html: PAYLOAD.html,
      text: 'Hello & welcome',
      category: 'transactional',
      idempotencyKey: 'email-outbox:row-1',
    });
    expect(message).not.toHaveProperty('from');
  });

  it('derives a plain-text alternative from the html when the template supplied none', async () => {
    const { sender, send } = fakeSender(() => Promise.resolve({ id: 'r', transport: 'graph' }));
    await new GraphEmailProvider(CONFIG, () => sender).send({ ...PAYLOAD, text: undefined });
    expect(send.mock.calls[0][0].text).toBe('Hello & welcome\nSecond');
  });

  it('refuses marketing mail: Microsoft 365 is not for it', async () => {
    const { sender, send } = fakeSender(() => Promise.resolve({ id: 'r', transport: 'graph' }));
    await expect(
      new GraphEmailProvider(CONFIG, () => sender).send({ ...PAYLOAD, category: 'marketing' }),
    ).rejects.toBeInstanceOf(NonRetryableError);
    expect(send).not.toHaveBeenCalled();
  });

  it('dead-letters at once on an error retrying cannot fix (403: the app may not send as this mailbox)', async () => {
    const { sender } = fakeSender(() =>
      Promise.reject(
        new MailSendError('forbidden', 'Graph answered 403', { status: 403, requestId: 'abc' }),
      ),
    );
    const error = await new GraphEmailProvider(CONFIG, () => sender)
      .send(PAYLOAD)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NonRetryableError);
    expect((error as Error).message).toContain('403');
    expect((error as Error).message).not.toContain('someone@qnsc.vn');
  });

  it('honours the server’s own wait on throttling', async () => {
    const { sender } = fakeSender(() =>
      Promise.reject(
        new MailSendError('throttled', 'Graph answered 429', {
          status: 429,
          retryAfterSeconds: 45,
        }),
      ),
    );
    const error = await new GraphEmailProvider(CONFIG, () => sender)
      .send(PAYLOAD)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RetryAfterError);
    expect((error as RetryAfterError).retryAfterMs).toBe(45_000);
  });

  it('lets the relay back off on other retryable failures, and on anything it does not recognise', async () => {
    const unavailable = new MailSendError('unavailable', 'Graph answered 503', { status: 503 });
    const a = fakeSender(() => Promise.reject(unavailable));
    await expect(new GraphEmailProvider(CONFIG, () => a.sender).send(PAYLOAD)).rejects.toBe(
      unavailable,
    );
    const odd = new Error('socket hang up');
    const b = fakeSender(() => Promise.reject(odd));
    await expect(new GraphEmailProvider(CONFIG, () => b.sender).send(PAYLOAD)).rejects.toBe(odd);
  });

  describe('configuration', () => {
    it('builds the transport on the first send, not at construction (the API shares this module and has no credential)', async () => {
      const make = vi.fn(
        () => fakeSender(() => Promise.resolve({ id: 'r', transport: 'graph' })).sender,
      );
      const provider = new GraphEmailProvider({ ...CONFIG, clientId: undefined }, make);
      expect(make).not.toHaveBeenCalled();
      await provider.send(PAYLOAD);
      expect(make).toHaveBeenCalledOnce();
      await provider.send(PAYLOAD);
      expect(make).toHaveBeenCalledOnce();
    });

    it('hands the transport the mailbox, the app and the credential under platform-mail’s own names', () => {
      const make = vi.fn(
        () => fakeSender(() => Promise.resolve({ id: 'r', transport: 'graph' })).sender,
      );
      new GraphEmailProvider(
        { ...CONFIG, certificate: 'PEM', federatedTokenFile: '/var/run/token' },
        make,
      ).assertReady();
      expect(make).toHaveBeenCalledWith({
        MAIL_TRANSPORT: 'graph',
        MAIL_GRAPH_SENDER: 'noreply-opshub@qnsc.vn',
        NODE_ENV: 'production',
        AZURE_TENANT_ID: CONFIG.tenantId,
        AZURE_CLIENT_ID: CONFIG.clientId,
        AZURE_CLIENT_CERTIFICATE: 'PEM',
        AZURE_FEDERATED_TOKEN_FILE: '/var/run/token',
      });
    });

    it('assertReady names the missing variable (the worker calls it when the relay starts)', () => {
      expect(() =>
        new GraphEmailProvider({ ...CONFIG, clientId: undefined }).assertReady(),
      ).toThrow(/AZURE_CLIENT_ID/);
      expect(() => new GraphEmailProvider(CONFIG).assertReady()).toThrow(MailConfigError);
      expect(() => new GraphEmailProvider(CONFIG).assertReady()).toThrow(
        /AZURE_FEDERATED_TOKEN_FILE|AZURE_CLIENT_CERTIFICATE/,
      );
    });

    it('builds the REAL transport from a certificate, in production (a generated key and certificate, never committed)', () => {
      const dir = mkdtempSync(join(tmpdir(), 'opshub-mail-cert-'));
      try {
        execFileSync(
          'openssl',
          [
            'req',
            '-x509',
            '-newkey',
            'rsa:2048',
            '-nodes',
            '-days',
            '1',
            '-subj',
            '/CN=test',
            '-keyout',
            join(dir, 'k.pem'),
            '-out',
            join(dir, 'c.pem'),
          ],
          { stdio: 'ignore' },
        );
        const certificate =
          readFileSync(join(dir, 'k.pem'), 'utf8') + readFileSync(join(dir, 'c.pem'), 'utf8');
        expect(() =>
          new GraphEmailProvider({ ...CONFIG, certificate }).assertReady(),
        ).not.toThrow();
        // and base64, which is how the secret may hold it
        expect(() =>
          new GraphEmailProvider({
            ...CONFIG,
            certificate: Buffer.from(certificate).toString('base64'),
          }).assertReady(),
        ).not.toThrow();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
