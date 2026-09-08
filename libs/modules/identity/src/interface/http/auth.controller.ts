import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Auth,
  ApiCommonErrors,
  CurrentUser,
  Public,
  UnauthorizedException,
  ErrorCodes,
  AppConfigService,
  AuthzService,
  RateLimit,
  SelfScoped,
} from '@platform';
import type { JwtPayload } from '@platform';
import { AuthService } from '@quynhonsemiconductor/identity';
import { AuthMetrics } from '@quynhonsemiconductor/observability';
import type { FastifyRequest, FastifyReply } from 'fastify';
import '@fastify/cookie';
import { EntraLoginDto, DevLoginDto, AuthResponseDto, MeResponseDto } from './dto/auth.dto';
import { BFF_SESSION_COOKIE } from '@platform';
// `reply.generateCsrf` is a type augmentation contributed by @fastify/csrf-protection.
// The API registers that plugin in its bootstrap, but the WORKER build compiles this
// module too without ever touching the bootstrap — so without this type-only import the
// augmentation is absent from the worker's program and `nest build worker` fails with
// TS2339. Type-only: no runtime import is emitted.
import type {} from '@fastify/csrf-protection';
import { SEC_PER_DAY } from '@shared-kernel';

const REFRESH_COOKIE = 'refresh_token';
const CSRF_COOKIE = 'csrf_token';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  readonly #refreshMaxAge: number;

  constructor(
    @Inject(AuthService) private readonly authService: AuthService,
    private readonly config: AppConfigService,
    private readonly authz: AuthzService,
    private readonly authMetrics: AuthMetrics,
  ) {
    this.#refreshMaxAge = config.get('JWT_REFRESH_EXPIRY_DAYS') * SEC_PER_DAY;
  }

  /**
   * Adaptive cookie attributes. Same-site requests (the common SPA case) use
   * `SameSite=Lax`; genuine cross-site requests (different origin) fall back to
   * `SameSite=None; Secure` so the refresh cookie survives the redirect. `Secure`
   * is set whenever the request arrived over HTTPS (directly or via a proxy) or
   * whenever `SameSite=None` is required.
   */
  #buildRefreshCookieOptions(req: FastifyRequest, maxAge: number) {
    const forwardedProto = req.headers['x-forwarded-proto'];
    const isSecureRequest =
      req.protocol === 'https' ||
      (typeof forwardedProto === 'string' &&
        forwardedProto.split(',').some((v) => v.trim() === 'https'));

    const originHeader = req.headers.origin;
    let isCrossSite = false;
    if (typeof originHeader === 'string' && req.headers.host) {
      try {
        isCrossSite = new URL(originHeader).host !== req.headers.host;
      } catch {
        isCrossSite = false;
      }
    }

    const sameSite = isCrossSite ? ('none' as const) : ('lax' as const);
    const secure = isSecureRequest || sameSite === 'none';

    return { httpOnly: true, secure, sameSite, path: '/v1/auth', maxAge };
  }

  /** JS-readable CSRF cookie — same security attrs as the refresh cookie but site-wide and readable. */
  #buildCsrfCookieOptions(req: FastifyRequest, maxAge: number) {
    const opts = this.#buildRefreshCookieOptions(req, maxAge);
    return { ...opts, httpOnly: false, path: '/' };
  }

  /** Brute-force / credential-stuffing protection: 5 attempts per 15 min per IP. */
  @Post('entra-login')
  @Public()
  @RateLimit('AUTH_LOGIN')
  @HttpCode(200)
  @ApiOperation({
    summary: 'SSO login — validate Entra ID id_token, JIT-provision employee, mint internal JWT',
  })
  @ApiOkResponse({ type: AuthResponseDto })
  @ApiCommonErrors(401)
  async entraLogin(
    @Body() dto: EntraLoginDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthResponseDto> {
    let result: Awaited<ReturnType<AuthService['ssoLogin']>>;
    try {
      result = await this.authService.ssoLogin(dto.idToken, request.ip);
    } catch (err) {
      this.authMetrics.recordLogin('sso', 'failure');
      throw err;
    }
    this.authMetrics.recordLogin('sso', 'success');
    reply.setCookie(
      REFRESH_COOKIE,
      result.refreshToken,
      this.#buildRefreshCookieOptions(request, this.#refreshMaxAge),
    );
    reply.setCookie(
      CSRF_COOKIE,
      result.csrfToken,
      this.#buildCsrfCookieOptions(request, this.#refreshMaxAge),
    );
    return { accessToken: result.accessToken, expiresIn: result.expiresIn };
  }

  /**
   * Local-only password-less login for an existing active employee. The shared
   * AuthService rejects this whenever NODE_ENV === 'production'.
   */
  @Post('dev-login')
  @Public()
  @RateLimit('AUTH_LOGIN')
  @HttpCode(200)
  @ApiOperation({ summary: 'Dev login (non-production) — mint a session for an active employee' })
  @ApiOkResponse({ type: AuthResponseDto })
  @ApiCommonErrors(401)
  async devLogin(
    @Body() dto: DevLoginDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthResponseDto> {
    let result: Awaited<ReturnType<AuthService['devLogin']>>;
    try {
      result = await this.authService.devLogin(dto.email, request.ip);
    } catch (err) {
      this.authMetrics.recordLogin('dev', 'failure');
      throw err;
    }
    this.authMetrics.recordLogin('dev', 'success');
    reply.setCookie(
      REFRESH_COOKIE,
      result.refreshToken,
      this.#buildRefreshCookieOptions(request, this.#refreshMaxAge),
    );
    reply.setCookie(
      CSRF_COOKIE,
      result.csrfToken,
      this.#buildCsrfCookieOptions(request, this.#refreshMaxAge),
    );
    return { accessToken: result.accessToken, expiresIn: result.expiresIn };
  }

  @Post('refresh')
  @Public()
  @RateLimit('AUTH_REFRESH')
  @HttpCode(200)
  @ApiOperation({ summary: 'Silently refresh the access token using the HttpOnly refresh cookie' })
  @ApiOkResponse({ type: AuthResponseDto })
  @ApiCommonErrors(401)
  async refresh(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthResponseDto> {
    const rawToken = request.cookies?.[REFRESH_COOKIE];
    if (!rawToken) {
      reply.clearCookie(REFRESH_COOKIE, { path: '/v1/auth' });
      throw new UnauthorizedException(ErrorCodes.AUTH_INVALID_CREDENTIALS, 'No refresh token');
    }
    // Double-submit CSRF: the client echoes the csrf_token cookie value in the
    // X-CSRF-Token header. The shared AuthService validates it against the value
    // bound to the session at login, then rotates both cookies.
    const csrfHeader = (request.headers['x-csrf-token'] as string | undefined) ?? null;
    const result = await this.authService.refresh(rawToken, csrfHeader, request.ip);
    reply.setCookie(
      REFRESH_COOKIE,
      result.refreshToken,
      this.#buildRefreshCookieOptions(request, this.#refreshMaxAge),
    );
    reply.setCookie(
      CSRF_COOKIE,
      result.csrfToken,
      this.#buildCsrfCookieOptions(request, this.#refreshMaxAge),
    );
    return { accessToken: result.accessToken, expiresIn: result.expiresIn };
  }

  @Post('logout')
  @SelfScoped("revokes the caller's own session")
  @HttpCode(204)
  @ApiOperation({
    summary:
      'Revoke the current session — invalidates both the refresh token and the active access token',
  })
  @ApiNoContentResponse()
  async logout(
    @CurrentUser() user: JwtPayload,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    // The shared AuthService denylists the access-token jti (until its natural
    // expiry) and revokes the session row identified by sessionId.
    await this.authService.logout(user);
    reply.clearCookie(REFRESH_COOKIE, { path: '/v1/auth' });
    reply.clearCookie(CSRF_COOKIE, { path: '/' });
  }

  @Get('me')
  @SelfScoped("returns the caller's own principal")
  @Auth()
  @ApiOperation({ summary: 'Return the authenticated principal and its effective permissions' })
  @ApiOkResponse({ type: MeResponseDto })
  @ApiCommonErrors(401)
  async me(
    @CurrentUser() user: JwtPayload,
    @Req() request: FastifyRequest & { bffSid?: string },
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<MeResponseDto> {
    // Effective permissions come from the DB (the single source of truth the
    // PolicyGuard also enforces). The SPA gates its UI on this list rather than
    // re-deriving permissions from role names, so FE and BE can never drift.
    const effective = await this.authz.resolve(user.sub);
    return {
      sub: user.sub,
      email: user.email,
      name: user.name,
      roles: user.roles,
      permissions: Object.keys(effective),
      // Minted here rather than from a dedicated endpoint: the SPA already calls this on
      // every start and page refresh, so the token's lifecycle matches the session's
      // with no extra round-trip, and `generateCsrf` plants the signed secret cookie on
      // the first call.
      //
      // Only for a request that arrived on the session COOKIE. A Bearer caller cannot be
      // the victim of CSRF — it attaches its credential by hand — so it needs no token,
      // and minting one would set a CSRF secret cookie on API clients that will never
      // send it back.
      csrfToken: request.bffSid
        ? reply.generateCsrf({ userInfo: request.cookies?.[BFF_SESSION_COOKIE] ?? '' })
        : undefined,
    };
  }
}
