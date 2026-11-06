import { type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { requestContextStorage } from '@quynhonsemiconductor/observability';
import {
  consumeMcpCallToken,
  isMcpBridged,
  mintMcpCallToken,
  MCP_CALL_TOKEN_HEADER,
  type McpPrincipalContext,
} from '@platform';
import { McpPrincipalGuard } from './principal.guard';

const USER = '0194a000-0000-7000-8000-0000000000aa';
const SESSION = 'mcp:req-1';

const ctx = (req: Record<string, unknown>): ExecutionContext =>
  ({
    getType: () => 'http',
    getHandler: () => () => undefined,
    getClass: () => class Route {},
    switchToHttp: () => ({ getRequest: () => req }),
  }) as unknown as ExecutionContext;

const guard = (isPublic = false) =>
  new McpPrincipalGuard({
    getAllAndOverride: () => (isPublic ? true : undefined),
  } as unknown as Reflector);

const principal: McpPrincipalContext = {
  userId: USER,
  email: 'jane@qnsc.vn',
  name: 'Jane',
  sessionId: SESSION,
};

/** `setRequestPrincipal` writes into this store; the request pipeline seeds it per request. */
function inRequestContext<T>(fn: () => T): T {
  return requestContextStorage.run(
    {
      workspaceId: undefined,
      userId: undefined,
      sessionId: undefined,
      correlationId: 'spec-correlation-id',
      traceparent: undefined,
    },
    fn,
  );
}

describe('McpPrincipalGuard', () => {
  it('consumes the call token into the principal the session path reads, and records it', () => {
    const req: Record<string, unknown> = {
      headers: { [MCP_CALL_TOKEN_HEADER]: mintMcpCallToken(principal) },
    };
    let recorded: Record<string, unknown> | undefined;
    inRequestContext(() => {
      expect(guard().canActivate(ctx(req))).toBe(true);
      recorded = { ...requestContextStorage.getStore() };
    });
    expect(req['user']).toEqual({
      sub: USER,
      email: 'jane@qnsc.vn',
      name: 'Jane',
      roles: [],
      sessionId: SESSION,
    });
    expect(recorded).toMatchObject({ userId: USER, sessionId: SESSION });
    expect(isMcpBridged(req)).toBe(true);
    // consumed AND removed: the HTTP access log serializes req.headers, and this token is a credential
    expect((req['headers'] as Record<string, unknown>)[MCP_CALL_TOKEN_HEADER]).toBeUndefined();
  });

  it('the token is single-use: a replay carries no principal and no bridge marker', () => {
    const token = mintMcpCallToken(principal);
    expect(consumeMcpCallToken(token)).toEqual(principal);
    expect(consumeMcpCallToken(token)).toBeUndefined();

    const req: Record<string, unknown> = { headers: { [MCP_CALL_TOKEN_HEADER]: token } };
    expect(guard().canActivate(ctx(req))).toBe(true);
    expect(req['user']).toBeUndefined();
    expect(isMcpBridged(req)).toBe(false);
  });

  it('an unknown or malformed token is no context; a network request cannot forge one', () => {
    for (const token of [undefined, '', 'forged.token.value', 'A'.repeat(64)]) {
      const req: Record<string, unknown> = {
        headers: { [MCP_CALL_TOKEN_HEADER]: token, 'cf-access-jwt-assertion': 'forged' },
      };
      expect(guard().canActivate(ctx(req))).toBe(true);
      expect(req['user']).toBeUndefined();
      expect(isMcpBridged(req)).toBe(false);
    }
  });

  it('an in-process request with NO token at all is not authenticated by the guard', () => {
    const req: Record<string, unknown> = { headers: {} };
    expect(inRequestContext(() => guard().canActivate(ctx(req)))).toBe(true);
    // the guard passes through, the request stays unauthenticated: identity's SessionGuard
    // (not in this unit) answers 401 — pinned against a live app in route.spec.ts.
    expect(req['user']).toBeUndefined();
    expect(isMcpBridged(req)).toBe(false);
  });

  it('does not authenticate a @Public() route', () => {
    const req: Record<string, unknown> = {
      headers: { [MCP_CALL_TOKEN_HEADER]: mintMcpCallToken(principal) },
    };
    expect(guard(true).canActivate(ctx(req))).toBe(true);
    expect(req['user']).toBeUndefined();
    // the token was NOT consumed: a public route must not spend the unlock of the route it wrapped
    expect(isMcpBridged(req)).toBe(false);
  });

  it('a non-http execution context passes through', () => {
    const nonHttp = { getType: () => 'rpc' } as unknown as ExecutionContext;
    expect(guard().canActivate(nonHttp)).toBe(true);
  });
});
