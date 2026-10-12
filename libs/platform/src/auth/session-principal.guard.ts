import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RequestContextService } from '@quynhonsemiconductor/observability';
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

/**
 * Authentication for opshub's routes, on top of identity 8.
 *
 * `@quynhonsemiconductor/identity`'s `SessionGuard` is registered globally (`APP_GUARD`) by the identity
 * module: it resolves the session cookie, refuses a request without one, and puts `{ session, user }` on
 * the request. A banned (offboarded) user's session never gets that far: identity checks the user whenever
 * a session is read. This guard is the route-level half that `@Auth()` and `@RequirePermission()` mount: it
 * turns that session into opshub's request principal (`request.user`) and stamps the request context so the
 * logging interceptor and `AuditService` can read the actor without parameter threading.
 *
 * It does NOT read the database: the identity user already carries the id, email and name, and permissions are
 * resolved per request by `PolicyGuard`.
 */
@Injectable()
export class SessionAuthGuard implements CanActivate {
  private readonly logger = new Logger(SessionAuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly ctx: RequestContextService,
  ) {}

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
    this.ctx.setAuthContext(undefined, found.user.id, found.session.id);
    return true;
  }
}
