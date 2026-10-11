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
