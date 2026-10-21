import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { setRequestPrincipal } from '@quynhonsemiconductor/observability';
import { IS_PUBLIC_KEY } from './decorators';
import type { JwtPayload } from './principal';

/** What identity's global `SessionGuard` leaves on the request: the `{ session, user }` of the cookie. */
interface RequestWithSession {
  session?: {
    session: { id: string };
    user: { id: string; email: string; name: string };
  };
  user?: JwtPayload;
}

/** Set once per process: the request context is missing, so every later request would log the same line. */
let loggedNoRequestContext = false;

/**
 * Authentication for opshub's routes, on top of identity 8.
 *
 * `@quynhonsemiconductor/identity`'s `SessionGuard` is registered globally (`APP_GUARD`) by the identity
 * module: it resolves the session cookie, refuses a request without one, and puts `{ session, user }` on
 * the request. A banned (offboarded) user's session never gets that far: identity checks the user whenever
 * a session is read. This guard is the route-level half that `@Auth()` and `@RequirePermission()` mount: it
 * turns that session into opshub's request principal (`request.user`) and records the principal in the
 * request context (`setRequestPrincipal`), where platform-http's rate limit, idempotency, access log and
 * exception filter read the caller. Nothing there reads `req.user`.
 *
 * It does NOT read the database: the identity user already carries the id, email and name, and permissions are
 * resolved per request by `PolicyGuard`.
 */
@Injectable()
export class SessionAuthGuard implements CanActivate {
  private readonly logger = new Logger(SessionAuthGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<RequestWithSession>();
    const found = request.session;
    if (!found?.user?.id) {
      // identity's global guard answers first; this is the belt for a route mounted without it
      this.logger.warn('SessionAuthGuard reached a route with no identity session');
      throw new UnauthorizedException('Sign in required');
    }

    request.user = {
      sub: found.user.id,
      email: found.user.email,
      name: found.user.name,
      roles: [],
      sessionId: found.session.id,
    };
    this.recordPrincipal(found.user.id, found.session.id);
    return true;
  }

  /**
   * Writes the principal into the request context, which is what platform-http reads.
   *
   * `setRequestPrincipal` returns false when nothing seeded a request context (`CORRELATION_ID_MODE=disabled`).
   * Then the rate limit keys this caller by session and the access log has no `userId`, and nothing else says
   * so, so it is logged once per process. It throws for a value that is not a plain id (control characters,
   * too long). The request is already verified, so it is served anyway. Nothing is written in that case, and only the
   * error class is logged: identity ids are uuids, which always pass the check, so a refusal is not an identity id.
   */
  private recordPrincipal(userId: string, sessionId: string): void {
    try {
      if (!setRequestPrincipal({ userId, sessionId }) && !loggedNoRequestContext) {
        loggedNoRequestContext = true;
        this.logger.error(
          'SessionAuthGuard: no request context to record the principal in; the rate limit and access log lose the user id. Check CORRELATION_ID_MODE.',
        );
      }
    } catch (err) {
      this.logger.warn(
        `SessionAuthGuard: platform-http refused the principal (${err instanceof Error ? err.name : 'unknown'})`,
      );
    }
  }
}
