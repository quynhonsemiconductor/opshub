import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  consumeMcpCallToken,
  mintMcpCallToken,
  peekMcpCallToken,
  type McpPrincipalContext,
} from './mcp-call-token';

const principal: McpPrincipalContext = {
  userId: '0194a000-0000-7000-8000-0000000000aa',
  email: 'jane@qnsc.vn',
  name: 'Jane',
  sessionId: 'mcp:req-1',
};

afterEach(() => vi.useRealTimers());

describe('MCP call token', () => {
  it('carries the principal and the query, and peek does not spend the token', () => {
    const token = mintMcpCallToken(principal, { search: 'jane' });
    expect(peekMcpCallToken(token)).toEqual({ principal, query: { search: 'jane' } });
    expect(consumeMcpCallToken(token)).toEqual(principal);
    expect(consumeMcpCallToken(token)).toBeUndefined();
  });

  it('a token past its 5 s TTL is refused by BOTH consume and peek', () => {
    vi.useFakeTimers();
    const token = mintMcpCallToken(principal);
    vi.advanceTimersByTime(5_001);
    expect(consumeMcpCallToken(token)).toBeUndefined();
  });

  it('peek removes an expired entry instead of leaving the person behind', () => {
    vi.useFakeTimers();
    const token = mintMcpCallToken(principal, { search: 'stale-search' });
    vi.advanceTimersByTime(5_001);
    expect(peekMcpCallToken(token)).toBeUndefined();
    expect(peekMcpCallToken(token)).toBeUndefined();
  });

  it('a mint sweeps expired entries, so an unconsumed token does not live forever', () => {
    vi.useFakeTimers();
    const stale = mintMcpCallToken(principal, { search: 'stale-search' });
    vi.advanceTimersByTime(5_001);
    const fresh = mintMcpCallToken(principal);
    expect(peekMcpCallToken(stale)).toBeUndefined();
    expect(peekMcpCallToken(fresh)).toEqual({ principal });
  });
});
