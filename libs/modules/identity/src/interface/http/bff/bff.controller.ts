import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Logger,
  NotFoundException,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import '@fastify/cookie';
import {
  Auth,
  CurrentUser,
  ErrorCodes,
  Public,
  RateLimit,
  UnauthorizedException,
  SelfScoped,
} from '@platform';
import type { JwtPayload } from '@platform';
import { BffService, readCookie } from '@qnsc-vn/identity';
import { BffLoginDto, DevLoginDto } from '../dto/auth.dto';
import {
  BFF_SESSION_COOKIE,
  BFF_STATE_COOKIE,
  BFF_STATE_COOKIE_MAX_AGE_SECONDS,
} from './bff.constants';

/**
 * Backend-for-Frontend auth surface: runs the Entra Authorization-Code + PKCE flow
 * server-side and issues an opaque `__Host-` session cookie, so no Entra or JWT token
 * ever reaches the browser. The SPA holds no credential it could leak to an XSS payload.
 *
 * This works only because the SPA and the API are same-origin — the Cloudflare Pages
 * Function at `apps/web/functions/v1/[[path]].ts` forwards `/v1/*` to the API origin. A
 * `__Host-` cookie cannot be set cross-site, so without that proxy none of these routes
 * can log anyone in.
 *
 * Deliberately smaller than rally's equivalent, in two ways:
 *
 *  - ONE login route, not three. opshub authenticates against a single directory (the
 *    company Entra tenant), so the shared BffService's plain home path is used and the
 *    multi-IdP broker — its connection registry, the `sso_connections` table and the
 *    email-first routing UI — is never wired. Those collaborators are `@Optional()` in
 *    the package precisely so a single-directory product can skip them.
 *  - NO `/bff/me`. The platform guard authenticates a session cookie on ANY route, so
 *    the existing `GET /v1/auth/me` already serves a BFF session; duplicating it here
 *    would be a second copy of the same contract to keep in step. It mints the CSRF
 *    token instead, for cookie-authenticated callers only.
 *
 * Excluded from Swagger: these are browser-redirect endpoints, not a JSON API.
 */
@ApiExcludeController()
@Controller('bff')
export class BffController {
  private readonly logger = new Logger(BffController.name);

  constructor(@Inject(BffService) private readonly bff: BffService) {}

  // ── POST /bff/login ────────────────────────────────────────────────────────
  // Public. Starts the Entra flow: generates PKCE + `state`, persists the pending
  // request server-side, sets the browser-bound `state` cookie and hands the SPA the
  // authorize URL to redirect to. No email is asked for — there is one directory.
  @Post('login')
  @Public()
  @RateLimit('AUTH_LOGIN')
  @HttpCode(200)
  async login(
    @Body() dto: BffLoginDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ authorizeUrl: string }> {
    const { authorizeUrl, state } = await this.bff.beginLogin(dto.returnTo);
    reply.setCookie(BFF_STATE_COOKIE, state, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax', // must survive the top-level redirect back from Entra
      path: '/',
      maxAge: BFF_STATE_COOKIE_MAX_AGE_SECONDS,
    });
    return { authorizeUrl };
  }

  // ── GET /bff/callback ──────────────────────────────────────────────────────
  // Public: Entra redirects here with ?code&state. Verifies the state against the
  // browser's cookie, exchanges the code, mints a server-side session, sets the
  // `__Host-` session cookie and 302s to the validated returnTo.
  @Get('callback')
  @Public()
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    if (!code || !state) {
      throw new UnauthorizedException(
        ErrorCodes.AUTH_TOKEN_INVALID,
        'Missing authorization code or state',
      );
    }

    const cookieState = readCookie(req, BFF_STATE_COOKIE);
    let result: { sid: string; returnTo: string };
    try {
      result = await this.bff.completeLogin({ code, state, cookieState, ip: req.ip });
    } catch (err) {
      // Never surface OIDC or internal detail on the login path: the browser is an
      // unauthenticated caller here, and the failure reason (bad state, expired auth
      // request, token-exchange rejection) is exactly what an attacker probing the
      // callback wants to learn. Logged server-side only, at error level, so it still
      // shows up in Loki without ever reaching the response.
      this.logger.error({ err }, 'BFF callback failed to complete login');
      throw new UnauthorizedException(
        ErrorCodes.AUTH_TOKEN_INVALID,
        'Login could not be completed',
      );
    }

    reply.clearCookie(BFF_STATE_COOKIE, { path: '/' });
    reply.setCookie(BFF_SESSION_COOKIE, result.sid, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict', // same-origin by construction, so Strict costs nothing
      path: '/',
      maxAge: this.bff.sessionTtlSeconds,
    });
    // Version-agnostic 302 (avoids Fastify `reply.redirect` argument-order drift).
    reply.header('location', result.returnTo).status(302).send();
  }

  // ── POST /bff/dev-login ────────────────────────────────────────────────────
  // DEV/E2E ONLY — 404 in production. Mints a real server-side session without an
  // Entra round-trip so the same-origin cookie flow can be exercised locally. Note
  // this is unreachable in BOTH deployed environments, which run NODE_ENV=production
  // on purpose: a passwordless login on a public host would let anyone holding a
  // seeded address sign in as that user.
  @Post('dev-login')
  @Public()
  @HttpCode(204)
  async devLogin(
    @Body() dto: DevLoginDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    if (!this.bff.devLoginAllowed) {
      throw new NotFoundException();
    }
    const sid = await this.bff.devLogin(dto.email, req.ip);
    reply.setCookie(BFF_SESSION_COOKIE, sid, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge: this.bff.sessionTtlSeconds,
    });
  }

  // ── POST /bff/logout ───────────────────────────────────────────────────────
  // Authenticated through the guard's session-cookie path. `bffSid` is populated by
  // JwtAuthGuard when it resolves the session, so logout revokes the session the
  // request actually arrived on rather than whatever the cookie currently says.
  @Post('logout')
  @SelfScoped("destroys the caller's own server-side session")
  @HttpCode(204)
  @Auth()
  async logout(
    @CurrentUser() user: JwtPayload,
    @Req() req: FastifyRequest & { bffSid?: string },
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const sid = req.bffSid ?? readCookie(req, BFF_SESSION_COOKIE);
    if (sid) {
      // Drops the server-side session AND denylists the access token it held, so the
      // logout is effective immediately rather than at token expiry.
      await this.bff.logout(sid, user);
    }
    // Cleared unconditionally: a session that was already gone server-side must still
    // leave the browser, or the SPA keeps presenting a cookie that can never work.
    reply.clearCookie(BFF_SESSION_COOKIE, { path: '/' });
  }
}
