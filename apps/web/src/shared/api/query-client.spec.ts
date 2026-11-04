// @vitest-environment node
/**
 * The query client's default retry policy.
 *
 * A 429 is a wait, not a failure. These pin the two halves that are easy to get wrong: how long to
 * wait (the server's `Retry-After`, capped) and which answers never get a second attempt (401/403, and
 * a 429 past the retry budget). The generated client retries 429 reads at the transport layer; this
 * policy covers errors thrown by a queryFn that already carries the status.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from './query-client';
import { RATE_LIMIT_MAX_DELAY_MS, retryAfterMs, rateLimitDelayMs } from './rate-limit-retry';

const defaults = queryClient.getDefaultOptions().queries!;
const retry = defaults.retry as (failureCount: number, error: unknown) => boolean;
const retryDelay = defaults.retryDelay as (failureCount: number, error: unknown) => number;

afterEach(() => {
  vi.useRealTimers();
});

describe('the DEFAULT retry policy', () => {
  it('never retries a 401 or 403 — those answers will not improve', () => {
    expect(retry(0, { status: 401 })).toBe(false);
    expect(retry(0, { status: 403 })).toBe(false);
  });

  it('retries a 429 twice, then stops', () => {
    expect(retry(0, { status: 429 })).toBe(true);
    expect(retry(1, { status: 429 })).toBe(true);
    expect(retry(2, { status: 429 })).toBe(false);
  });

  it('waits the Retry-After the 429 carries', () => {
    expect(retryDelay(0, { status: 429, retryAfterMs: 1_000 })).toBe(1_000);
  });

  it('falls back to exponential backoff when the 429 carries no header', () => {
    expect(retryDelay(0, { status: 429 })).toBe(500);
    expect(retryDelay(1, { status: 429 })).toBe(1_000);
  });

  it('caps the wait however large the header is', () => {
    expect(retryDelay(0, { status: 429, retryAfterMs: 3_600_000 })).toBe(RATE_LIMIT_MAX_DELAY_MS);
  });

  it('retries an ordinary transient failure once, on TanStack’s default backoff', () => {
    expect(retry(0, new Error('network'))).toBe(true);
    expect(retry(1, new Error('network'))).toBe(false);
    expect(retryDelay(0, new Error('network'))).toBe(1_000);
  });
});

describe('Retry-After parsing', () => {
  it('reads delta-seconds', () => {
    expect(retryAfterMs('2')).toBe(2_000);
    expect(retryAfterMs('0')).toBe(0);
  });

  it('reads an HTTP-date', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-04T12:00:00Z'));
    expect(retryAfterMs('Wed, 04 Nov 2026 12:00:03 GMT')).toBe(3_000);
  });

  it('is null when absent or unparseable, so the caller backs off instead', () => {
    expect(retryAfterMs(null)).toBeNull();
    expect(retryAfterMs('soon')).toBeNull();
  });

  it('caps the wait when applied to a response', () => {
    const response = new Response(null, { status: 429, headers: { 'retry-after': '3600' } });
    expect(rateLimitDelayMs(0, response)).toBe(RATE_LIMIT_MAX_DELAY_MS);
  });
});
