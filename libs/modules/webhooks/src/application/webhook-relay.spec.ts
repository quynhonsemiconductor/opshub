/**
 * WebhookRelayService unit tests.
 *
 * Tests HMAC-SHA256 signature generation, correct HTTP headers, and exponential
 * backoff delay calculation — all without a real HTTP server or database.
 *
 * Strategy:
 *  - `deliver()` (the HTTP POST) is protected, so we expose it via a thin test subclass.
 *  - `markFailed()` and `markSent()` are similarly exposed.
 *  - `fetch` is replaced with a vi.stubGlobal() spy so we can control responses.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/*
 * NO REAL DNS IN A UNIT TEST.
 *
 * The relay resolves the target host immediately before delivering, which is the defence against a
 * subscription URL being re-pointed at the VPC after it was saved. In a unit test that became a genuine
 * lookup of `example.com`: one case took five seconds, and under the full suite the timing made two
 * unrelated header assertions read a previous test's recorded call. It passed in isolation and failed in
 * the suite — introduced by the SSRF change and missed because I ran that spec on its own.
 *
 * Stubbed to a public address, so the resolve-time check runs its real logic and reaches its verdict
 * without leaving the process. Cases that need a REFUSAL use literal private addresses, which the static
 * half of the check answers without any lookup at all.
 */
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
}));
import { createHmac } from 'crypto';
import { WebhookRelayService } from './webhook-relay.service';
import type { DrizzleTx } from '@platform';

// ── Test subclass exposing protected methods ──────────────────────────────────

class TestableRelayService extends WebhookRelayService {
  /** `deliver` is the HTTP POST; it runs with no transaction open, so it takes no `tx`. */
  public exposedProcessRow(row: ReturnType<typeof makeRow>) {
    return this.deliver({ ...row, leaseToken: 'lease-1' });
  }

  public exposedMarkSent(tx: DrizzleTx, rowId: string) {
    return this.markSent(tx, { ...makeRow({ id: rowId }), leaseToken: 'lease-1' });
  }

  /** `attempts` is the row's CLAIMED attempt count: the claim already spent it. */
  public exposedMarkFailed(
    tx: DrizzleTx,
    rowId: string,
    attempts: number,
    newStatus: 'pending' | 'failed',
    error: string,
  ) {
    // The base class's generic backoff, which this relay ignores in favour of its own
    // RETRY_DELAYS_SECONDS curve. A recognisable sentinel keeps that visible: if epoch 0 ever
    // shows up in an assertion below, the relay stopped honouring its own schedule.
    return this.markFailed(
      tx,
      { ...makeRow({ id: rowId, attempts }), leaseToken: 'lease-1' },
      newStatus,
      error,
      new Date(0),
    );
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'delivery-1',
    subscriptionId: 'sub-1',
    eventType: 'request.approved',
    payload: { requestId: 'req-abc', type: 'leave' },
    attempts: 0,
    url: 'https://example.com/webhook',
    secret: 'super-secret-key-with-16-chars!!',
    ...overrides,
  };
}

function makeMockDb() {
  const updateChain: Record<string, ReturnType<typeof vi.fn>> = {
    update: vi.fn(),
    set: vi.fn(),
    where: vi.fn(),
  };
  updateChain.update.mockReturnValue(updateChain);
  updateChain.set.mockReturnValue(updateChain);
  updateChain.where.mockResolvedValue(undefined);

  return {
    update: updateChain.update,
    // NOT `async`, and no eslint-disable: the callback already returns the promise the
    // relay awaits, so `async` added nothing but a require-await violation to suppress.
    // The suppression was worse than it looked — prettier reflows this call across lines
    // and carries the `eslint-disable-next-line` away from the arrow it was written for,
    // so the pre-commit hook (eslint --fix, THEN prettier --write) could turn a clean
    // lint into two errors after eslint had already approved the file.
    transaction: vi.fn().mockImplementation((cb: (tx: unknown) => unknown) => cb(updateChain)),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('WebhookRelayService — HMAC signature', () => {
  let service: TestableRelayService;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const db = makeMockDb();
    service = new TestableRelayService(db as never);

    mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends POST with Content-Type: application/json', async () => {
    await service.exposedProcessRow(makeRow());
    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((options.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('includes X-OpsHub-Event header matching the event type', async () => {
    const row = makeRow({ eventType: 'request.rejected' });
    await service.exposedProcessRow(row);
    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((options.headers as Record<string, string>)['X-OpsHub-Event']).toBe('request.rejected');
  });

  it('includes X-OpsHub-Delivery header matching the delivery id', async () => {
    const row = makeRow({ id: 'del-xyz' });
    await service.exposedProcessRow(row);
    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((options.headers as Record<string, string>)['X-OpsHub-Delivery']).toBe('del-xyz');
  });

  it('generates a valid HMAC-SHA256 signature for the exact body sent', async () => {
    const row = makeRow();
    let capturedBody = '';
    let capturedSig = '';

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    mockFetch.mockImplementation((url: string, opts: RequestInit) => {
      capturedBody = opts.body as string;
      capturedSig = (opts.headers as Record<string, string>)['X-OpsHub-Signature'];
      return Promise.resolve({ ok: true });
    });

    await service.exposedProcessRow(row);

    const expectedSig = `sha256=${createHmac('sha256', row.secret).update(capturedBody).digest('hex')}`;
    expect(capturedSig).toBe(expectedSig);
  });

  it('body JSON contains id, eventType, payload, and timestamp fields', async () => {
    const row = makeRow({ id: 'del-123', eventType: 'request.submitted' });
    let parsedBody: Record<string, unknown> = {};

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    mockFetch.mockImplementation((_: string, opts: RequestInit) => {
      parsedBody = JSON.parse(opts.body as string) as Record<string, unknown>;
      return Promise.resolve({ ok: true });
    });

    await service.exposedProcessRow(row);

    expect(parsedBody).toMatchObject({
      id: 'del-123',
      eventType: 'request.submitted',
      payload: { requestId: 'req-abc', type: 'leave' },
    });
    expect(typeof parsedBody['timestamp']).toBe('string');
    // timestamp must be ISO 8601
    expect(() => new Date(parsedBody['timestamp'] as string).toISOString()).not.toThrow();
  });

  it('posts to the correct URL from the row', async () => {
    const row = makeRow({ url: 'https://hooks.myapp.io/receive' });
    await service.exposedProcessRow(row);
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe('https://hooks.myapp.io/receive');
  });

  it('throws when the server responds with a non-2xx status', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503, statusText: 'Service Unavailable' });
    await expect(service.exposedProcessRow(makeRow())).rejects.toThrow('HTTP 503');
  });

  it('throws when fetch rejects (network error)', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(service.exposedProcessRow(makeRow())).rejects.toThrow('ECONNREFUSED');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Exponential backoff delay calculation
// ═════════════════════════════════════════════════════════════════════════════

describe('WebhookRelayService — markFailed() backoff delays', () => {
  // RETRY_DELAYS_SECONDS = [60, 300, 900, 3600]
  const EXPECTED_DELAYS = [60, 300, 900, 3600];

  let service: TestableRelayService;
  let updateChain: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    updateChain = {
      update: vi.fn(),
      set: vi.fn(),
      where: vi.fn().mockResolvedValue(undefined),
    };
    updateChain.update.mockReturnValue(updateChain);
    updateChain.set.mockReturnValue(updateChain);

    service = new TestableRelayService({ update: updateChain.update } as never);
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => vi.unstubAllGlobals());

  for (let attempt = 1; attempt <= 4; attempt++) {
    it(`sets nextAttemptAt ≈ now + ${EXPECTED_DELAYS[attempt - 1]}s on attempt ${attempt}`, async () => {
      const before = Date.now();
      await service.exposedMarkFailed(
        updateChain as never,
        'del-1',
        attempt,
        'pending',
        'some error',
      );
      const after = Date.now();

      const setArgs = updateChain.set.mock.calls[0]?.[0] as Record<string, unknown>;
      const nextAt = (setArgs?.['nextAttemptAt'] as Date).getTime();
      const expectedDelay = (EXPECTED_DELAYS[attempt - 1] ?? 3600) * 1000;

      expect(nextAt).toBeGreaterThanOrEqual(before + expectedDelay - 50);
      expect(nextAt).toBeLessThanOrEqual(after + expectedDelay + 50);
    });
  }

  it('sets status=failed when newAttempts >= maxAttempts (5)', async () => {
    await service.exposedMarkFailed(updateChain as never, 'del-1', 5, 'failed', 'error');
    const setArgs = updateChain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArgs?.['status']).toBe('failed');
  });

  it('sets status=pending for intermediate failures', async () => {
    await service.exposedMarkFailed(updateChain as never, 'del-1', 2, 'pending', 'error');
    const setArgs = updateChain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArgs?.['status']).toBe('pending');
  });

  it('truncates lastError to 2000 characters', async () => {
    const longError = 'x'.repeat(3000);
    await service.exposedMarkFailed(updateChain as never, 'del-1', 1, 'pending', longError);
    const setArgs = updateChain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect((setArgs?.['lastError'] as string).length).toBe(2000);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// markSent()
// ═════════════════════════════════════════════════════════════════════════════

describe('WebhookRelayService — markSent()', () => {
  it('sets status=delivered and deliveredAt to now', async () => {
    const chain = {
      update: vi.fn(),
      set: vi.fn(),
      where: vi.fn().mockResolvedValue(undefined),
    };
    chain.update.mockReturnValue(chain);
    chain.set.mockReturnValue(chain);

    const service = new TestableRelayService({ update: chain.update } as never);

    const before = Date.now();
    await service.exposedMarkSent(chain as never, 'del-1');
    const after = Date.now();

    const setArgs = chain.set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArgs?.['status']).toBe('delivered');
    const deliveredAt = (setArgs?.['deliveredAt'] as Date).getTime();
    expect(deliveredAt).toBeGreaterThanOrEqual(before - 50);
    expect(deliveredAt).toBeLessThanOrEqual(after + 50);
  });
});

describe('the target is checked again at delivery time', () => {
  /*
   * WHY THE DTO'S CHECK IS NOT ENOUGH, and why removing this one broke no test until now.
   *
   * The DTO judges the URL string when the subscription is saved. That protects against a typo. It does
   * not protect against an author: a hostname that resolved publicly then can be re-pointed at the VPC
   * afterwards, and the stored URL never changes. So the relay resolves the name again immediately
   * before the request — and the mutation that deleted that call passed every existing test, which is
   * the reason this block exists.
   */
  it('refuses an unsafe target and never issues the request', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const relay = new TestableRelayService({} as never);

    await expect(
      relay.exposedProcessRow(makeRow({ url: 'https://169.254.169.254/latest/meta-data/' })),
    ).rejects.toThrow(/Refusing to deliver/);

    // The point is the request not happening. A throw after the POST would leave the side effect done.
    expect(fetchSpy, 'the relay contacted the target before refusing it').not.toHaveBeenCalled();
  });

  it('names the reason, which reaches the subscription owner', async () => {
    /*
     * Thrown rather than skipped, so the row takes the ordinary failure path: attempts increment and the
     * text lands in `last_error`, which the deliveries endpoint returns. A silent drop would leave a
     * subscription that looks healthy and delivers nothing.
     */
    vi.stubGlobal('fetch', vi.fn());
    const relay = new TestableRelayService({} as never);

    await expect(
      relay.exposedProcessRow(makeRow({ url: 'https://10.0.4.17:5432/' })),
    ).rejects.toThrow(/blocked range/);
  });

  it('still delivers to a safe target', async () => {
    // The converse. A relay that refused everything would satisfy both cases above.
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
    vi.stubGlobal('fetch', fetchSpy);
    const relay = new TestableRelayService({} as never);

    await relay.exposedProcessRow(makeRow({ url: 'https://hooks.example.com/opshub' }));

    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});
