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
  roles: ['employee'],
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
