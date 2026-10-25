import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import {
  MailConfigError,
  MailSendError,
  type EmailMessage,
  type EmailSender,
} from '@quynhonsemiconductor/platform-mail/sender';
import { DeferError, NonRetryableError, RetryAfterError } from '../../outbox/abstract-outbox-relay';
import {
  GraphEmailProvider,
  SENDER_BLOCKED_BACKOFF_MS,
  SENDER_BLOCKED_FIELD,
  type GraphMailConfig,
} from './graph.provider';

const CONFIG: GraphMailConfig = {
  sender: 'noreply-opshub@qnsc.vn',
  tenantId: '11111111-1111-1111-1111-111111111111',
  clientId: '22222222-2222-2222-2222-222222222222',
  certificatePath: undefined,
  federatedTokenFile: undefined,
  nodeEnv: 'production',
};

const PAYLOAD = {
  to: 'someone@qnsc.vn',
  subject: 'Approve the request',
  html: '<p>Hello &amp; welcome</p><p>Second</p>',
  text: 'Hello & welcome',
  category: 'transactional' as const,
  idempotencyKey: 'email-outbox:row-1',
};

function fakeSender(
  send: (
    m: EmailMessage,
    o?: { signal?: AbortSignal },
  ) => Promise<{ id: string; transport: 'graph' }>,
) {
  const spy = vi.fn(send);
  const sender = { mailbox: 'noreply-opshub@qnsc.vn', send: spy } as unknown as EmailSender;
  return { sender, send: spy };
}

describe('GraphEmailProvider', () => {
  it('logs the field the email-sender-blocked alarm filters on, once, with no recipient', async () => {
    expect(SENDER_BLOCKED_FIELD).toBe('senderBlocked');
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const { sender } = fakeSender(() =>
        Promise.reject(
          new MailSendError('forbidden', 'Graph answered 403', { status: 403, requestId: 'rid-1' }),
        ),
      );
      await new GraphEmailProvider(CONFIG, () => sender).send(PAYLOAD).catch(() => undefined);
      const blocked = error.mock.calls.filter(
        ([fields]) => (fields as Record<string, unknown>)?.[SENDER_BLOCKED_FIELD],
      );
      expect(blocked).toHaveLength(1);
      expect(blocked[0][0]).toEqual({
        senderBlocked: 'forbidden',
        status: 403,
        requestId: 'rid-1',
      });
    } finally {
      error.mockRestore();
    }
  });

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

  describe('what is a message problem and what is a sender problem', () => {
    it.each([
      ['invalid_message', 400],
      ['too_large', 413],
    ] as const)(
      '%s (HTTP %i) is about THIS message: dead-lettered at once',
      async (code, status) => {
        const { sender } = fakeSender(() =>
          Promise.reject(
            new MailSendError(code, `Graph answered ${status}`, { status, requestId: 'abc' }),
          ),
        );
        const error = await new GraphEmailProvider(CONFIG, () => sender)
          .send(PAYLOAD)
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(NonRetryableError);
        expect((error as Error).message).toContain(String(status));
        expect((error as Error).message).not.toContain('someone@qnsc.vn');
      },
    );

    it.each([
      ['forbidden', 403],
      ['mailbox_not_found', 404],
      ['unauthenticated', 401],
    ] as const)(
      '%s (HTTP %i) on sendMail is about the SENDER or its credential (role not assigned or still propagating, mailbox missing, certificate expired or wrong): defer 15 minutes, never burn attempts',
      async (code, status) => {
        const { sender } = fakeSender(() =>
          Promise.reject(new MailSendError(code, `Graph answered ${status}`, { status })),
        );
        const error = await new GraphEmailProvider(CONFIG, () => sender)
          .send(PAYLOAD)
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(DeferError);
        expect(error).not.toBeInstanceOf(NonRetryableError);
        expect((error as DeferError).delayMs).toBe(SENDER_BLOCKED_BACKOFF_MS);
      },
    );

    it('STOPS THE BATCH: after a sender refusal the next rows are deferred without calling Graph, until the backoff passes', async () => {
      let clock = 1_000_000;
      let refuse = true;
      const { sender, send } = fakeSender(() =>
        refuse
          ? Promise.reject(new MailSendError('forbidden', 'Graph answered 403', { status: 403 }))
          : Promise.resolve({ id: 'req-9', transport: 'graph' }),
      );
      const provider = new GraphEmailProvider(
        CONFIG,
        () => sender,
        () => clock,
      );

      await expect(provider.send(PAYLOAD)).rejects.toBeInstanceOf(DeferError);
      expect(send).toHaveBeenCalledTimes(1);

      // The rest of the batch, and rows that arrive meanwhile: deferred for what is LEFT of the window, no request made.
      clock += 60_000;
      const second = await provider
        .send({ ...PAYLOAD, idempotencyKey: 'k2' })
        .catch((e: unknown) => e);
      expect(second).toBeInstanceOf(DeferError);
      expect((second as DeferError).delayMs).toBe(SENDER_BLOCKED_BACKOFF_MS - 60_000);
      expect(send).toHaveBeenCalledTimes(1);

      // After the window the role has propagated: Graph is asked again, and the send goes through.
      clock += SENDER_BLOCKED_BACKOFF_MS;
      refuse = false;
      await expect(provider.send({ ...PAYLOAD, idempotencyKey: 'k3' })).resolves.toEqual({
        messageId: 'req-9',
      });
      expect(send).toHaveBeenCalledTimes(2);
    });
  });

  it('gives an expired or mismatched credential its own reason in the senderBlocked log', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const { sender } = fakeSender(() =>
        Promise.reject(new MailSendError('unauthenticated', 'AADSTS700027', { status: 401 })),
      );
      await new GraphEmailProvider(CONFIG, () => sender).send(PAYLOAD).catch(() => undefined);
      const blocked = error.mock.calls.filter(
        ([fields]) => (fields as Record<string, unknown>)?.[SENDER_BLOCKED_FIELD],
      );
      expect(blocked).toHaveLength(1);
      expect((blocked[0][0] as Record<string, unknown>)[SENDER_BLOCKED_FIELD]).toBe(
        'unauthenticated',
      );
    } finally {
      error.mockRestore();
    }
  });

  it('hands the caller’s deadline signal to the transport, so the request, its retries and any Retry-After wait stop when it fires', async () => {
    const { sender, send } = fakeSender(() => Promise.resolve({ id: 'r', transport: 'graph' }));
    const controller = new AbortController();
    await new GraphEmailProvider(CONFIG, () => sender).send(PAYLOAD, { signal: controller.signal });
    expect(send.mock.calls[0][1]).toEqual({ signal: controller.signal });
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
        {
          ...CONFIG,
          certificatePath: '/mnt/secrets/opshub-graph-cert.pem',
          federatedTokenFile: '/var/run/token',
        },
        make,
      ).assertReady();
      expect(make).toHaveBeenCalledWith({
        MAIL_TRANSPORT: 'graph',
        MAIL_GRAPH_SENDER: 'noreply-opshub@qnsc.vn',
        NODE_ENV: 'production',
        AZURE_TENANT_ID: CONFIG.tenantId,
        AZURE_CLIENT_ID: CONFIG.clientId,
        AZURE_CLIENT_CERTIFICATE_PATH: '/mnt/secrets/opshub-graph-cert.pem',
        AZURE_FEDERATED_TOKEN_FILE: '/var/run/token',
      });
    });

    it('assertReady names the missing variable (the worker calls it when the relay starts)', () => {
      expect(() =>
        new GraphEmailProvider({ ...CONFIG, clientId: undefined }).assertReady(),
      ).toThrow(/AZURE_CLIENT_ID/);
      expect(() => new GraphEmailProvider(CONFIG).assertReady()).toThrow(MailConfigError);
      expect(() => new GraphEmailProvider(CONFIG).assertReady()).toThrow(
        /AZURE_FEDERATED_TOKEN_FILE|AZURE_CLIENT_CERTIFICATE_PATH/,
      );
    });

    it('builds the REAL transport from the certificate FILE at AZURE_CLIENT_CERTIFICATE_PATH, in production (a generated key and certificate, never committed)', () => {
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
        // ONE combined PEM, private key FIRST, then the certificate — the mounted file's shape.
        const pemPath = join(dir, 'graph-cert.pem');
        writeFileSync(
          pemPath,
          readFileSync(join(dir, 'k.pem'), 'utf8') + readFileSync(join(dir, 'c.pem'), 'utf8'),
        );
        expect(() =>
          new GraphEmailProvider({ ...CONFIG, certificatePath: pemPath }).assertReady(),
        ).not.toThrow();
        // a path to nothing fails at configuration time, naming the variable
        expect(() =>
          new GraphEmailProvider({
            ...CONFIG,
            certificatePath: join(dir, 'missing.pem'),
          }).assertReady(),
        ).toThrow(MailConfigError);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
