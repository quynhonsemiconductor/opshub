import { type CanActivate, type ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { markPreAuthenticated } from '@quynhonsemiconductor/identity/nest';
import { setRequestPrincipal } from '@quynhonsemiconductor/observability';
import {
  consumeMcpCallToken,
  IS_PUBLIC_KEY,
  markMcpBridged,
  MCP_CALL_TOKEN_HEADER,
  type McpPrincipalContext,
} from '@platform';
import type { JwtPayload } from '@platform';

interface McpRequest {
  headers: Record<string, string | string[] | undefined>;
  user?: JwtPayload;
}

/**
 * Bridges the MCP in-process principal into the request the session path already reads.
 *
 * A GLOBAL guard, registered in a module imported BEFORE `AuthModule` (global guard order is
 * module import order, and both neighbours matter): it must run AFTER the pre-auth rate limiter
 * (which keys on the address, not on any credential) and BEFORE identity's `SessionGuard` (so
 * `markPreAuthenticated` makes it stand aside — while still running its ban check — for an MCP
 * principal).
 *
 * When the request carries a live single-use MCP call token (minted only by the MCP transport,
 * inside the process — see `mcp-call-token.ts` for why this is not AsyncLocalStorage), this guard
 * consumes it and writes the principal where the rest of the codebase reads it:
 *
 *  - `request.user`, the `JwtPayload` every controller and `PolicyGuard` reads — so authorization
 *    is the SAME decision, from the same database reads, as the person's session path;
 *  - the request context (`setRequestPrincipal`), so the rate limiter keys by the person and the
 *    access log names them — the same contract `SessionAuthGuard` keeps;
 *  - `markPreAuthenticated(req, { userId })`, so identity's `SessionGuard` stands aside AND still
 *    runs its ban check on the user, exactly as it does for a session.
 *
 * With NO live token it does nothing: an `inject()` outside MCP falls through to the session path,
 * has no cookie, and is refused 401 by the SessionGuard. The context is not ambient.
 *
 * It reads NOTHING from the request but the single-use token: a network request cannot forge the
 * in-process principal (pinned by principal.guard.spec.ts and the e2e suite).
 */
@Injectable()
export class McpPrincipalGuard implements CanActivate {
  private readonly logger = new Logger(McpPrincipalGuard.name);
  /** The no-request-context error is logged once per process. */
  private static warnedNoContext = false;

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<McpRequest>();

    // ONLY the header named by the constant, and only as a one-time key into the in-process
    // token store: the header carries an opaque token, never a principal, and is consumed here.
    const raw = request.headers[MCP_CALL_TOKEN_HEADER];
    const mcp: McpPrincipalContext | undefined = consumeMcpCallToken(raw);
    if (!mcp) return true;

    // The token has served its purpose (the exchange above), so remove it before anything can
    // serialize the request: the shared pino redaction list covers the rova header name, and a
    // credential must not depend on that list matching this product's constant.
    delete (request.headers as Record<string, unknown>)[MCP_CALL_TOKEN_HEADER];

    // The belt guards key off this marker, not off `request.user`'s mere presence.
    markMcpBridged(request);

    request.user = {
      sub: mcp.userId,
      email: mcp.email,
      name: mcp.name,
      // Empty, always. `PolicyGuard` resolves permissions from the database per request.
      roles: [],
      sessionId: mcp.sessionId,
    };

    // Same contract as SessionAuthGuard: the rate limit, idempotency key, access log and exception
    // filter read the person from here. Never fails the request.
    try {
      const written = setRequestPrincipal({ userId: mcp.userId, sessionId: mcp.sessionId });
      if (!written && !McpPrincipalGuard.warnedNoContext) {
        McpPrincipalGuard.warnedNoContext = true;
        this.logger.error(
          'No request context to record the MCP principal in: seed it with enableCorrelationId(app).',
        );
      }
    } catch (err) {
      this.logger.warn(
        { err: (err as Error)?.constructor?.name },
        'Could not record the MCP principal in the request context',
      );
    }

    // SessionGuard stands aside, but still runs its ban check on this user — a banned person's
    // MCP tools stop the same way their session does.
    markPreAuthenticated(request, { userId: mcp.userId });
    return true;
  }
}
