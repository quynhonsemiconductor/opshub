import { UnauthorizedException } from '@nestjs/common';
import { requestContextStorage } from '@quynhonsemiconductor/observability';
import { describe, expect, it, vi } from 'vitest';
import { IS_PUBLIC_KEY } from './decorators';
import { SessionAuthGuard } from './session-principal.guard';

/**
 * The route-level half of authentication on identity 8: it turns the session identity's global guard
 * resolved into opshub's request principal, and refuses a request that has none.
 */

function setup(options: { isPublic?: boolean; session?: unknown } = {}) {
  const request: { session?: unknown; user?: unknown } = {
    ...(options.session === undefined ? {} : { session: options.session }),
  };
  const reflector = {
    getAllAndOverride: vi.fn((key: string) =>
      key === IS_PUBLIC_KEY ? options.isPublic : undefined,
    ),
  };
  const ctx = { setAuthContext: vi.fn() };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  } as never;
  const guard = new SessionAuthGuard(reflector as never, ctx as never);
  const log = vi.fn();
  (guard as unknown as { logger: Record<string, unknown> }).logger['error'] = log;
  (guard as unknown as { logger: Record<string, unknown> }).logger['warn'] = log;
  return { guard, context, request, ctx, log };
}

const SESSION = {
  session: { id: 'session-1' },
  user: { id: 'user-1', email: 'jane@qnsc.vn', name: 'Jane' },
};

/** A request context as enableCorrelationId seeds it, so setRequestPrincipal has somewhere to write. */
function seeded<T>(run: () => T): T {
  return requestContextStorage.run(
    {
      workspaceId: undefined,
      userId: undefined,
      sessionId: undefined,
      correlationId: 'c-1',
      traceparent: undefined,
    },
    run,
  );
}

describe('SessionAuthGuard', () => {
  it('builds the principal from the identity session', () => {
    const { guard, context, request } = setup({ session: SESSION });

    expect(seeded(() => guard.canActivate(context))).toBe(true);

    expect(request.user).toEqual({
      sub: 'user-1',
      email: 'jane@qnsc.vn',
      name: 'Jane',
      // roles are NOT read from the session: `/v1/auth/me` shows employees.roles, and authorization is
      // resolved from the database on every request
      roles: [],
      sessionId: 'session-1',
    });
  });

  it('records the principal in the request context, which is what the rate limit and the access log read', () => {
    const { guard, context, ctx } = setup({ session: SESSION });
    const store = {
      workspaceId: undefined,
      userId: undefined,
      sessionId: undefined,
      correlationId: 'c-1',
      traceparent: undefined,
    };

    requestContextStorage.run(store, () => guard.canActivate(context));

    expect(store).toMatchObject({ userId: 'user-1', sessionId: 'session-1' });
    expect(ctx.setAuthContext).not.toHaveBeenCalled();
  });

  it('logs once and still serves when there is no request context to record the principal in', () => {
    const { guard, context, log } = setup({ session: SESSION });

    expect(guard.canActivate(context)).toBe(true);
    expect(guard.canActivate(context)).toBe(true);

    expect(log).toHaveBeenCalledTimes(1);
  });

  it('serves a verified request whose id the context refuses, writing it unchecked and logging only the class', () => {
    const { guard, context, ctx, log } = setup({
      session: { session: { id: 'session-1' }, user: { id: 'bad\u0001id', email: 'a', name: 'a' } },
    });

    expect(seeded(() => guard.canActivate(context))).toBe(true);

    expect(ctx.setAuthContext).toHaveBeenCalledWith(undefined, 'bad\u0001id', 'session-1');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('TypeError'));
  });

  it('refuses a request with no session (fail closed, even if identity’s guard was not mounted)', () => {
    const { guard, context, request } = setup();

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    expect(request.user).toBeUndefined();
  });

  it('refuses a session without a user id', () => {
    const { guard, context } = setup({ session: { session: { id: 's' }, user: {} } });

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('lets a @Public() route through without a session, and sets no principal', () => {
    const { guard, context, request, ctx } = setup({ isPublic: true });

    expect(guard.canActivate(context)).toBe(true);
    expect(request.user).toBeUndefined();
    expect(ctx.setAuthContext).not.toHaveBeenCalled();
  });
});
