import {
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { AuthTokenCache } from '@quynhonsemiconductor/identity';
import { failOpenLog } from '@quynhonsemiconductor/observability';
import {
  BFF_SESSION_COOKIE,
  BFF_SESSION_RESOLVER,
  type BffSessionResolver,
} from './bff-session-resolver';
import { IS_PUBLIC_KEY } from './decorators';
import { RequestContextService } from '../context/request-context';
import type { JwtPayload } from './jwt.strategy';

/**
 * JWT auth guard.
 * Verifies the Bearer access token, checks the revocation denylist in Redis,
 * then stamps request context so the logging interceptor and AuditService can
 * read the actor without explicit parameter threading.
 *
 * BFF (same-origin) mode: when a {@link BffSessionResolver} is bound and the request
 * carries no Bearer token, the guard authenticates from the opaque `__Host-` session
 * cookie instead — resolving, and transparently refreshing, the server-side session.
 * Both paths then run the SAME denylist checks and stamp the SAME request context, so
 * nothing downstream can tell them apart. While the resolver is unbound the cookie path
 * is skipped entirely and the Bearer flow is byte-for-byte unchanged.
 *
 * Bearer always takes precedence: a caller that attaches a token by hand has stated
 * which credential it means, and silently preferring an ambient cookie over it would
 * make the effective identity depend on browser state.
 *
 * Pair with @Public() decorator to opt-out individual routes.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly authCache: AuthTokenCache,
    private readonly ctx: RequestContextService,
    @Optional()
    @Inject(BFF_SESSION_RESOLVER)
    private readonly bffResolver?: BffSessionResolver,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      cookies?: Record<string, string | undefined>;
      ip: string;
      user?: JwtPayload;
      bffSid?: string;
    }>();

    if (this.bffResolver?.enabled && !hasBearerToken(request.headers['authorization'])) {
      const sid = request.cookies?.[BFF_SESSION_COOKIE];
      if (sid) return this.authenticateFromSession(request, sid);
    }

    let result: boolean;
    try {
      result = await (super.canActivate(context) as Promise<boolean>);
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      this.logger.error({ err }, 'JWT strategy error during canActivate');
      throw new UnauthorizedException('Authentication service unavailable');
    }
    if (!result) return false;

    const user = request.user as JwtPayload;
    await this.enforceDenylist(user.jti, user.sub);
    return true;
  }

  /**
   * Authenticate from a BFF session id: resolve the session, run the same denylist
   * checks as the Bearer path, then populate `request.user`, `request.bffSid` and the
   * ALS context. `bffSid` is what lets logout revoke the session it actually arrived on
   * without re-reading the cookie.
   *
   * The context stamping is duplicated from `handleRequest` rather than shared, because
   * `handleRequest` is a passport callback that only fires on the Bearer path — a
   * session-authenticated request would otherwise log and audit with no actor at all.
   */
  private async authenticateFromSession(
    request: { ip: string; user?: JwtPayload; bffSid?: string },
    sid: string,
  ): Promise<boolean> {
    const claims = await this.bffResolver!.resolve(sid, request.ip);
    if (!claims) {
      throw new UnauthorizedException('Invalid or expired session');
    }
    await this.enforceDenylist(claims.jti, claims.sub);

    request.user = claims;
    request.bffSid = sid;
    const store = this.ctx.getStore();
    if (store) {
      store.userId = claims.sub;
      store.userEmail = claims.email;
    }
    return true;
  }

  /**
   * Two fast-revocation checks (OWASP JWT Cheat Sheet, §No Built-In Token Revocation),
   * both served by the shared identity AuthTokenCache (Redis denylist):
   *   1. Session-level — explicit logout or rotation-theft detection denylists the
   *      access-token `jti`.
   *   2. User-level — offboarding revokes all outstanding access tokens for the
   *      employee via the `denylist:user:*` scheme.
   *
   * Shared by both authentication paths on purpose: a session cookie that skipped
   * revocation would make logout and offboarding effective for API clients and inert
   * for browsers, which is the direction that matters.
   */
  private async enforceDenylist(jti: string, sub: string): Promise<void> {
    try {
      const [sessionDenied, userRevoked] = await Promise.all([
        this.authCache.isTokenDenied(jti),
        this.authCache.isUserRevoked(sub),
      ]);
      if (sessionDenied || userRevoked) {
        throw new UnauthorizedException('Session has been revoked');
      }
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      // Fail open — Redis unavailable should not block valid users.
      // Tokens still expire naturally via the JWT exp claim (max 15 min window).
      // Tagged with the shared helper, not a bare object: the field name is what the
      // CloudWatch metric filter matches, so it must come from one place. See
      // aws_cloudwatch_log_metric_filter.security_fail_open in infra/modules/stack.
      this.logger.warn(
        failOpenLog('denylist', { err }),
        'Token denylist check failed; failing open',
      );
    }
  }

  handleRequest<TUser extends JwtPayload>(err: Error | null, user: TUser | false): TUser {
    if (err) {
      if (err instanceof UnauthorizedException) throw err;
      this.logger.error({ err }, 'Unexpected error in JWT handleRequest');
      throw new UnauthorizedException('Invalid or expired access token');
    }
    if (!user) {
      throw new UnauthorizedException('Invalid or expired access token');
    }

    // Stamp the per-request ALS context so the logging interceptor and
    // AuditService can read the actor without explicit parameter threading.
    const store = this.ctx.getStore();
    if (store) {
      store.userId = user.sub;
      store.userEmail = user.email;
    }

    return user;
  }
}

/** True when the Authorization header carries a Bearer token. */
function hasBearerToken(authorization: string | string[] | undefined): boolean {
  const value = Array.isArray(authorization) ? authorization[0] : authorization;
  return typeof value === 'string' && value.trim().toLowerCase().startsWith('bearer ');
}
