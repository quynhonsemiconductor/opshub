import { UnauthorizedException } from '@nestjs/common';
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
  return { guard, context, request, ctx };
}

const SESSION = {
  session: { id: 'session-1' },
  user: { id: 'user-1', email: 'jane@qnsc.vn', name: 'Jane' },
};

describe('SessionAuthGuard', () => {
  it('builds the principal from the identity session', () => {
    const { guard, context, request } = setup({ session: SESSION });

    expect(guard.canActivate(context)).toBe(true);

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

  it('stamps the request context, so the logs and the audit log can name the actor', () => {
    const { guard, context, ctx } = setup({ session: SESSION });

    guard.canActivate(context);

    expect(ctx.setAuthContext).toHaveBeenCalledWith(undefined, 'user-1', 'session-1');
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
