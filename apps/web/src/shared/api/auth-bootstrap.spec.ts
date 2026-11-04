// @vitest-environment jsdom
/**
 * The bootstrap hands its answer to the query cache, so nothing asks for it twice.
 *
 * WHAT WAS WRONG. `bootstrapAuth` fetches `GET /v1/auth/me` before React mounts — it has to, because
 * the router guard cannot decide anything until the session is known — and then threw the response body
 * away after copying five fields into the auth store. `useCurrentUser` asked the API for the same
 * document a moment later, because it had no way to know the answer already existed. Measured on a
 * Playwright run over the same two spec files: 26 `GET /v1/auth/me` for 26 mounts before, 13 after.
 *
 * Every page load, for every real user, paid for that.
 *
 * The other property here is about IDENTITY: `resetBootstrap` runs on logout and must leave nothing of
 * the previous session in the cache.
 */
import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ME_QUERY_KEY } from '@/shared/hooks/use-current-user';
import { bootstrapAuth, resetBootstrap } from './auth-bootstrap';
import { queryClient } from './query-client';
import { useAuthStore } from './auth-store';
import { getCsrfToken } from './csrf';

const ME = {
  sub: 'emp-1',
  email: 'jane@acme.com',
  name: 'Jane Doe',
  groups: ['employee'],
  permissions: ['asset.read'],
  csrfToken: 'csrf-1',
};

function response(body: unknown = ME, status = 200, retryAfter?: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(retryAfter === undefined ? {} : { 'retry-after': retryAfter }),
    json: () => Promise.resolve(body),
  };
}

function stubMe(body: unknown = ME, status = 200) {
  const spy = vi.fn().mockResolvedValue(response(body, status));
  vi.stubGlobal('fetch', spy);
  return spy;
}

/** Fail `failures.length` times with these responses, then answer 200 with ME. */
function stubThenOk(...failures: Array<{ status: number; retryAfter?: string }>) {
  const spy = vi.fn();
  for (const failure of failures) {
    spy.mockResolvedValueOnce(response({}, failure.status, failure.retryAfter));
  }
  spy.mockResolvedValue(response(ME));
  vi.stubGlobal('fetch', spy);
  return spy;
}

beforeEach(() => {
  // `resetBootstrap` is the production reset, and using it here means these tests exercise it rather
  // than reaching into the module's private promise.
  resetBootstrap();
  useAuthStore.getState().clear();
  useAuthStore.getState().setReady(false);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('bootstrapAuth', () => {
  it('seeds the me query, so the hook does not fetch it again', async () => {
    const fetchSpy = stubMe();

    await bootstrapAuth();

    /*
     * THE FIX, as a test. The cache entry has to exist under the key the hook reads — which is why that
     * key is exported rather than written out in three files, since a typo here is invisible: the hook
     * simply fetches, exactly as it did before, and nothing fails.
     */
    expect(queryClient.getQueryData(ME_QUERY_KEY)).toMatchObject({
      sub: 'emp-1',
      email: 'jane@acme.com',
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('stores the whole document, not the five fields the auth store keeps', async () => {
    stubMe();
    await bootstrapAuth();

    // The store holds what authorization needs; the cache holds what the profile screen renders. Seeding
    // the store's subset would leave the hook refetching for the fields it lacked, which is the bug.
    const cached = queryClient.getQueryData<typeof ME>(ME_QUERY_KEY);
    expect(cached?.name).toBe('Jane Doe');
    expect(cached?.permissions).toEqual(['asset.read']);
  });

  it('caches nothing when the caller is not signed in', async () => {
    // A 401 is the ordinary "not signed in yet" answer. Caching it would hand the hook a non-answer it
    // would then treat as data.
    stubMe({}, 401);

    await bootstrapAuth();

    expect(queryClient.getQueryData(ME_QUERY_KEY)).toBeUndefined();
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().error).toBeNull();
  });

  it('caches nothing and reports rather than clears on a transient failure', async () => {
    // The bug: a 500 used to be treated as "signed out", so the login page appeared over a valid cookie.
    stubThenOk({ status: 500 }, { status: 500 }, { status: 500 });
    vi.useFakeTimers();

    const pending = bootstrapAuth();
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;

    expect(queryClient.getQueryData(ME_QUERY_KEY)).toBeUndefined();
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().error).toMatch(/could not verify your session/i);
    // And the router still gets an answer: the shell must be able to render the retry screen.
    expect(useAuthStore.getState().ready).toBe(true);
  });

  it('keeps an established identity when the re-check is temporarily unavailable', async () => {
    useAuthStore.getState().setUser({
      sub: 'emp-1',
      email: 'jane@acme.com',
      name: 'Jane Doe',
      groups: [],
      permissions: [],
    });
    stubThenOk({ status: 503 }, { status: 503 }, { status: 503 });
    vi.useFakeTimers();

    const pending = bootstrapAuth();
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;

    // Unproven is not gone: only a 401/403 may clear the session.
    expect(useAuthStore.getState().user?.sub).toBe('emp-1');
    expect(useAuthStore.getState().error).toBeTruthy();
  });

  it('honours Retry-After on a 429, then signs in when the retry succeeds', async () => {
    const fetchSpy = stubThenOk({ status: 429, retryAfter: '2' });
    vi.useFakeTimers();

    const pending = bootstrapAuth();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchSpy).toHaveBeenCalledOnce(); // still waiting

    await vi.advanceTimersByTimeAsync(1);
    await pending;

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(useAuthStore.getState().user?.sub).toBe('emp-1');
    expect(useAuthStore.getState().error).toBeNull();
  });

  it('caps a Retry-After a proxy could send, so one boot cannot wait an hour', async () => {
    const fetchSpy = stubThenOk({ status: 429, retryAfter: '3600' });
    vi.useFakeTimers();

    const pending = bootstrapAuth();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchSpy).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('retries a network failure, and reports it after the cap instead of logging out', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchSpy);
    vi.useFakeTimers();

    const pending = bootstrapAuth();
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().error).toMatch(/could not be reached/i);
  });

  it('gives the session check a deadline, so a stall cannot hold the loading screen', async () => {
    const fetchSpy = stubMe();

    await bootstrapAuth();

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    // A connection that opens and stalls never rejects, so the `catch` that reports UNREACHABLE is
    // never reached without this. The deadline makes that stall a rejection.
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal?.aborted).toBe(false);
  });

  it('treats an aborted attempt as unreachable and retries it, not as a logout', async () => {
    const fetchSpy = vi
      .fn()
      .mockRejectedValueOnce(new DOMException('The operation timed out.', 'AbortError'))
      .mockResolvedValue(response(ME));
    vi.stubGlobal('fetch', fetchSpy);
    vi.useFakeTimers();

    const pending = bootstrapAuth();
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(useAuthStore.getState().user?.sub).toBe('emp-1');
    expect(useAuthStore.getState().error).toBeNull();
  });

  it('clears the session on a 403, which is a definite refusal', async () => {
    useAuthStore.getState().setUser({
      sub: 'emp-1',
      email: 'jane@acme.com',
      name: 'Jane Doe',
      groups: [],
      permissions: [],
    });
    stubMe({}, 403);

    await bootstrapAuth();

    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().error).toBeNull();
  });

  it('caches nothing when the network fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    vi.useFakeTimers();

    const pending = bootstrapAuth();
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;

    expect(queryClient.getQueryData(ME_QUERY_KEY)).toBeUndefined();
    // And it still finishes: the router has to be able to render the retry screen.
    expect(useAuthStore.getState().ready).toBe(true);
  });

  it('fetches once across concurrent callers', async () => {
    // React StrictMode double-invokes; both calls share the in-flight promise, or the duplicate this
    // whole change removes comes straight back through a different door.
    const fetchSpy = stubMe();

    await Promise.all([bootstrapAuth(), bootstrapAuth(), bootstrapAuth()]);

    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});

describe('resetBootstrap', () => {
  it('empties the cache, so one identity’s data cannot outlive its session', async () => {
    stubMe();
    await bootstrapAuth();
    // Something unrelated the previous session had read — a list the next identity may hold no
    // permission for.
    queryClient.setQueryData(['assets'], [{ id: 'asset-1' }]);

    resetBootstrap();

    expect(queryClient.getQueryData(ME_QUERY_KEY)).toBeUndefined();
    expect(queryClient.getQueryData(['assets'])).toBeUndefined();
  });

  it('lets the next navigation bootstrap again', async () => {
    const first = stubMe();
    await bootstrapAuth();
    expect(first).toHaveBeenCalledOnce();

    resetBootstrap();
    const second = stubMe();
    await bootstrapAuth();

    // Without the reset the memoised promise would resolve instantly and the next user would inherit
    // the previous session's answer.
    expect(second).toHaveBeenCalledOnce();
  });
});

describe('the query client', () => {
  it('is the same instance the providers mount', () => {
    // A second client would mean the bootstrap seeds a cache nothing reads — the silent version of this
    // bug, where every assertion above still passes.
    expect(queryClient).toBeInstanceOf(QueryClient);
    expect(queryClient.getDefaultOptions().queries?.staleTime).toBe(0);
  });

  it('keeps the CSRF token wired up, which shares this code path', async () => {
    stubMe();
    await bootstrapAuth();
    expect(getCsrfToken()).toBe('csrf-1');
  });
});
