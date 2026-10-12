import { describe, expect, it } from 'vitest';
import { NonRetryableError, RetryAfterError } from '@platform';
import { classifyGraphError } from './graph-errors';

const graphError = (statusCode: number, headers?: Record<string, string>) =>
  Object.assign(new Error(`status ${statusCode}`), {
    statusCode,
    headers: headers && { get: (n: string) => headers[n.toLowerCase()] ?? null },
  });

describe('classifyGraphError', () => {
  it.each([400, 403, 404])('%i will not heal on retry: dead-letter now', (status) => {
    expect(classifyGraphError(graphError(status))).toBeInstanceOf(NonRetryableError);
  });

  it.each([429, 503, 504])('%i with Retry-After waits as long as the server says', (status) => {
    const out = classifyGraphError(graphError(status, { 'retry-after': '120' }));
    expect(out).toBeInstanceOf(RetryAfterError);
    expect((out as RetryAfterError).retryAfterMs).toBe(120_000);
  });

  it('reads Retry-After as an HTTP date too', () => {
    const when = new Date(Date.now() + 60_000).toUTCString();
    const out = classifyGraphError(graphError(429, { 'retry-after': when })) as RetryAfterError;
    expect(out.retryAfterMs).toBeGreaterThan(50_000);
    expect(out.retryAfterMs).toBeLessThanOrEqual(61_000);
  });

  it('leaves a 429 with no Retry-After, and every other error, to the ordinary backoff', () => {
    const throttled = graphError(429);
    const other = new Error('ECONNRESET');
    expect(classifyGraphError(throttled)).toBe(throttled);
    expect(classifyGraphError(other)).toBe(other);
    expect(classifyGraphError(graphError(500))).toBeInstanceOf(Error);
    expect(classifyGraphError(graphError(500))).not.toBeInstanceOf(NonRetryableError);
  });
});

describe('classifyGraphError — Retry-After is clamped and validated', () => {
  const retry = (value: string) =>
    classifyGraphError(graphError(429, { 'retry-after': value })) as RetryAfterError;

  it('clamps an absurd value to one hour (1e13 seconds would be an Invalid Date)', () => {
    expect(retry('1e13')).toBeInstanceOf(RetryAfterError);
    expect(retry('1e13').retryAfterMs).toBe(60 * 60_000);
    expect(retry('999999').retryAfterMs).toBe(60 * 60_000);
  });

  it('clamps an HTTP date far in the future', () => {
    const farFuture = new Date(Date.now() + 365 * 86_400_000).toUTCString();
    expect(retry(farFuture).retryAfterMs).toBe(60 * 60_000);
  });

  it.each(['Infinity', '-5', 'NaN', 'soon', ''])(
    'ignores %j: ordinary backoff applies',
    (value) => {
      const throttled = graphError(429, { 'retry-after': value });
      expect(classifyGraphError(throttled)).toBe(throttled);
    },
  );

  it('passes a sane value through unchanged', () => {
    expect(retry('90').retryAfterMs).toBe(90_000);
  });
});
