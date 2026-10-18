/**
 * The sender and reply-to addresses, which are the two things a misconfigured mail setup gets wrong
 * silently.
 *
 * `MAIL_REPLY_TO` was declared in the env schema, listed in `.env.example`, and read by nothing. The
 * provider interface carried `replyTo` and `sendTemplate` accepted it per call, so the plumbing existed
 * end to end — no caller ever passed one and nothing supplied a default. An operator setting a reply-to
 * address got mail without one, and replies went back to a `no-reply` sender.
 *
 * So the properties worth pinning are about PRECEDENCE, not about whether a header is set: the
 * deployment-wide default must apply when nobody asks, and must lose when somebody does.
 */
import { describe, expect, it, vi } from 'vitest';
import { EMAIL_SEND_TIMEOUT_MS } from './email.provider';
import { EmailService } from './email.service';

interface SentPayload {
  from?: string;
  replyTo?: string;
  to: string;
}

function makeService(env: Record<string, string | undefined>) {
  const provider = { send: vi.fn().mockResolvedValue(undefined) };
  const config = { get: vi.fn((key: string) => env[key]) };
  // `provider` satisfies the port structurally, so only the config double needs a cast.
  const service = new EmailService(provider, config as never);
  /** The payload the provider was handed. Typed, so the assertions are not reaching into `any`. */
  const sent = (): SentPayload => provider.send.mock.calls[0][0] as SentPayload;
  return { service, provider, sent };
}

const CONFIGURED = {
  MAIL_FROM_NAME: 'OpsHub',
  MAIL_FROM_EMAIL: 'ops@example.com',
  MAIL_REPLY_TO: 'people@example.com',
};

/** Any real template + vars pair; the subject and body are not what these tests are about. */
async function send(
  service: EmailService,
  opts?: { replyTo?: string; idempotencyKey?: string },
): Promise<void> {
  await service.sendTemplate(
    'jane@example.com',
    'asset.assigned',
    {
      employeeName: 'Jane Doe',
      assetTag: 'LAP-0042',
      assetName: 'MacBook Pro 14',
      appUrl: 'https://opshub.example.com',
    },
    opts,
  );
}

describe('EmailService addresses', () => {
  it('supplies the deployment reply-to when the caller asks for none', async () => {
    // THE DEFECT, as a test. This was `undefined` on every send in the product.
    const { service, sent } = makeService(CONFIGURED);

    await send(service);

    expect(sent()).toMatchObject({ replyTo: 'people@example.com' });
  });

  it('lets a caller override it, which is what the per-call option is for', async () => {
    /*
     * The precedence, and it survived a mutation before this existed: making the deployment default win
     * unconditionally passed every other test here. A caller that names a reply-to has a reason — a
     * request thread, a specific mailbox — and silently redirecting it is worse than having no default.
     */
    const { service, sent } = makeService(CONFIGURED);

    await send(service, { replyTo: 'requests@example.com' });

    expect(sent()).toMatchObject({ replyTo: 'requests@example.com' });
  });

  it('sends no reply-to at all when the deployment sets none', async () => {
    // Absent, not empty string: an empty `Reply-To` header is a header, and some receivers treat one as
    // a reply address of nothing rather than as no preference.
    const { service, sent } = makeService({
      MAIL_FROM_NAME: 'OpsHub',
      MAIL_FROM_EMAIL: 'ops@example.com',
    });

    await send(service);

    expect(sent().replyTo).toBeUndefined();
  });

  it('builds the from address from the name and the email', async () => {
    const { service, sent } = makeService(CONFIGURED);
    await send(service);
    expect(sent()).toMatchObject({ from: 'OpsHub <ops@example.com>' });
  });

  it('leaves `from` undefined when no sender is configured', async () => {
    /*
     * Deliberate, and the provider is what refuses: `MAIL_FROM_EMAIL` lost its default because defaulting
     * it made a misconfigured production send from a domain it did not own — passing SPF nowhere, so
     * silent non-delivery. Undefined here reaches the provider, which throws with the variable's name.
     */
    const { service, sent } = makeService({ MAIL_FROM_NAME: 'OpsHub' });
    await send(service);
    expect(sent().from).toBeUndefined();
  });
});

describe('EmailService.sendTemplate — a send has a deadline', () => {
  it('rejects when the provider does not answer within EMAIL_SEND_TIMEOUT_MS', async () => {
    vi.useFakeTimers();
    try {
      const provider = { send: vi.fn(() => new Promise<never>(() => undefined)) };
      const service = new EmailService(provider, { get: vi.fn() } as never);

      const sending = service
        .sendTemplate('a@example.com', 'notification', {
          title: 't',
          body: 'b',
          appUrl: 'https://x',
        })
        .catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(EMAIL_SEND_TIMEOUT_MS + 1);

      expect(((await sending) as Error).message).toMatch(/did not answer within 30 s/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('hands the provider a signal that ABORTS at the deadline, so a late 202 cannot arrive after the relay has retried the row', async () => {
    vi.useFakeTimers();
    try {
      let seen: AbortSignal | undefined;
      const provider = {
        send: vi.fn((_payload: unknown, options?: { signal?: AbortSignal }) => {
          seen = options?.signal;
          return new Promise<never>(() => undefined);
        }),
      };
      const service = new EmailService(provider, { get: vi.fn() } as never);

      const sending = service
        .sendTemplate('a@example.com', 'notification', {
          title: 't',
          body: 'b',
          appUrl: 'https://x',
        })
        .catch((e: unknown) => e);
      expect(seen?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(EMAIL_SEND_TIMEOUT_MS + 1);

      expect(seen?.aborted).toBe(true);
      await sending;
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not log a deferred row as an error, and never logs the recipient of a failure', async () => {
    const { Logger } = await import('@nestjs/common');
    const { DeferError } = await import('../outbox/abstract-outbox-relay');
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const deferring = new EmailService(
        { send: vi.fn(() => Promise.reject(new DeferError('sender blocked', 900_000))) },
        { get: vi.fn() } as never,
      );
      await expect(
        deferring.sendTemplate('person@example.com', 'notification', {
          title: 't',
          body: 'b',
          appUrl: 'https://x',
        }),
      ).rejects.toBeInstanceOf(DeferError);
      expect(error).not.toHaveBeenCalled();

      const failing = new EmailService({ send: vi.fn(() => Promise.reject(new Error('boom'))) }, {
        get: vi.fn(),
      } as never);
      await failing
        .sendTemplate('person@example.com', 'notification', {
          title: 't',
          body: 'b',
          appUrl: 'https://x',
        })
        .catch(() => undefined);
      expect(error).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(error.mock.calls)).not.toContain('person@example.com');
    } finally {
      error.mockRestore();
    }
  });
});
