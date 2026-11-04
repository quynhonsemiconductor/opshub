// @vitest-environment jsdom
/**
 * The generated client's 429 retry.
 *
 * Every query in the SPA goes through this client, so retrying a rate-limited READ here means no
 * queryFn has to know `Retry-After` exists. The method check matters as much as the retry: repeating a
 * POST because the server was busy can duplicate a write.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './client';
import { RATE_LIMIT_MAX_DELAY_MS } from './rate-limit-retry';

const ME = {
  sub: 'emp-1',
  email: 'jane@acme.com',
  name: 'Jane Doe',
  groups: ['employee'],
  permissions: ['asset.read'],
};

function jsonBody(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('sessionMiddleware — rate-limited reads', () => {
  it('waits Retry-After and retries a GET, so the query never sees the 429', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        jsonBody({ message: 'Too many requests' }, 429, { 'retry-after': '1' }),
      )
      .mockResolvedValueOnce(jsonBody(ME));
    vi.stubGlobal('fetch', fetchSpy);
    vi.useFakeTimers();

    const pending = api.GET('/v1/auth/me', { baseUrl: 'http://localhost' });
    await vi.advanceTimersByTimeAsync(1_000);
    const { data, error } = await pending;

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(error).toBeUndefined();
    expect(data).toMatchObject({ sub: 'emp-1' });
  });

  it('caps the wait and gives up after two retries', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(
        jsonBody({ message: 'Too many requests' }, 429, { 'retry-after': '3600' }),
      );
    vi.stubGlobal('fetch', fetchSpy);
    vi.useFakeTimers();

    const pending = api.GET('/v1/auth/me', { baseUrl: 'http://localhost' });
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_MAX_DELAY_MS * 2);
    const { error } = await pending;

    // The first attempt plus exactly two retries; then the 429 is the answer.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(error).toMatchObject({ message: 'Too many requests' });
  });

  it('gives every attempt a deadline, so a stalled connection cannot hang the query', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        jsonBody({ message: 'Too many requests' }, 429, { 'retry-after': '0' }),
      )
      .mockResolvedValueOnce(jsonBody(ME));
    vi.stubGlobal('fetch', fetchSpy);
    vi.useFakeTimers();

    const pending = api.GET('/v1/auth/me', { baseUrl: 'http://localhost' });
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const signals = fetchSpy.mock.calls.map(
      (call) => (call[1] as RequestInit | undefined)?.signal ?? null,
    );
    // Both the first attempt and the retry carry one: a stalled connection never rejects, so without a
    // deadline the query stays pending and the screen shows a spinner that can never fail.
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[1]).toBeInstanceOf(AbortSignal);
    // A fresh deadline per attempt: one shared signal, aborted with the first attempt, would cancel the
    // retry it was meant to protect.
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals[0]?.aborted).toBe(false);
  });

  it('surfaces a timed-out attempt as a real error instead of hanging', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new DOMException('The operation timed out.', 'AbortError')),
    );

    // What the deadline produces. TanStack receives a rejection it can retry or report; it never sits
    // on a promise that no answer can settle.
    await expect(api.GET('/v1/auth/me', { baseUrl: 'http://localhost' })).rejects.toThrow(
      /timed out/i,
    );
  });

  it('does not replay a POST when the server is busy', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonBody({ message: 'Too many requests' }, 429));
    vi.stubGlobal('fetch', fetchSpy);

    const { error } = await api.POST('/v1/employees', {
      baseUrl: 'http://localhost',
      body: {} as never,
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(error).toMatchObject({ message: 'Too many requests' });
  });
});
