import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CSRF_HEADER, getCsrfToken, setCsrfToken, withCsrfHeader } from './csrf';
import { sessionFetch } from './session-fetch';

/**
 * The browser half of the double-submit check.
 *
 * The failure mode worth guarding is asymmetric: forgetting the token on a write gets a
 * 403 that reads like a permission bug, and sending it on a safe method is harmless. So
 * these pin "always on writes, never a surprise on reads", plus the two properties of
 * `sessionFetch` that no call site should have to remember.
 */

beforeEach(() => setCsrfToken(null));

describe('withCsrfHeader', () => {
  it('adds the token to a write', () => {
    setCsrfToken('tok-1');
    expect(withCsrfHeader('POST')).toEqual({ [CSRF_HEADER]: 'tok-1' });
  });

  it.each(['PUT', 'PATCH', 'DELETE'])('adds it to %s too', (method) => {
    setCsrfToken('tok-1');
    expect(withCsrfHeader(method)[CSRF_HEADER]).toBe('tok-1');
  });

  it.each(['GET', 'HEAD', 'OPTIONS', 'TRACE'])('omits it on %s', (method) => {
    setCsrfToken('tok-1');
    expect(withCsrfHeader(method)).toEqual({});
  });

  it('is case-insensitive about the method', () => {
    setCsrfToken('tok-1');
    expect(withCsrfHeader('get')).toEqual({});
    expect(withCsrfHeader('post')[CSRF_HEADER]).toBe('tok-1');
  });

  it('preserves the caller’s headers', () => {
    setCsrfToken('tok-1');
    expect(withCsrfHeader('POST', { accept: 'application/json' })).toEqual({
      accept: 'application/json',
      [CSRF_HEADER]: 'tok-1',
    });
  });

  it('adds nothing when no token has been issued', () => {
    // A request with no session cookie is never issued one, and an unauthenticated page has not bootstrapped
    // yet — neither should get an empty header, which the server would reject as invalid.
    expect(withCsrfHeader('POST')).toEqual({});
  });

  it('clears on logout', () => {
    setCsrfToken('tok-1');
    setCsrfToken(null);
    expect(getCsrfToken()).toBeNull();
    expect(withCsrfHeader('POST')).toEqual({});
  });

  it('names the header the server expects', () => {
    // Must match CSRF_HEADER in libs/platform/src/http/csrf.ts, which the server compares
    // case-insensitively but which appears in the CORS allow-list verbatim.
    expect(CSRF_HEADER.toLowerCase()).toBe('x-csrf-token');
  });
});

describe('sessionFetch', () => {
  /** Typed so `mock.calls[0][1]` is the RequestInit, not an empty tuple. */
  function capture() {
    const spy = vi.fn((...args: [string, RequestInit?]) => {
      void args;
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    vi.stubGlobal('fetch', spy);
    return spy;
  }

  it('always sends credentials, so no call site can drop the session cookie', async () => {
    const spy = capture();
    await sessionFetch('/v1/things');
    expect(spy.mock.calls[0][1]).toMatchObject({ credentials: 'include' });
  });

  it('attaches the CSRF token on a write', async () => {
    setCsrfToken('tok-1');
    const spy = capture();
    await sessionFetch('/v1/things', { method: 'POST', body: '{}' });
    expect((spy.mock.calls[0][1] as RequestInit).headers).toMatchObject({
      [CSRF_HEADER]: 'tok-1',
    });
  });

  it('sets Content-Type only when there is a body', async () => {
    const spy = capture();
    await sessionFetch('/v1/stream', { headers: { accept: 'text/event-stream' } });
    const headers = (spy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    // An SSE subscription must not be labelled as carrying a JSON payload.
    expect(headers['Content-Type']).toBeUndefined();
    expect(headers.accept).toBe('text/event-stream');
  });

  it('lets the caller override Content-Type', async () => {
    const spy = capture();
    await sessionFetch('/v1/upload', {
      method: 'POST',
      body: 'raw',
      headers: { 'Content-Type': 'text/plain' },
    });
    const headers = (spy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('text/plain');
  });

  it('passes the abort signal through', async () => {
    // SSE teardown depends on it: without the signal the stream outlives the component.
    const spy = capture();
    const controller = new AbortController();
    await sessionFetch('/v1/stream', { signal: controller.signal });
    expect((spy.mock.calls[0][1] as RequestInit).signal).toBe(controller.signal);
  });
});
