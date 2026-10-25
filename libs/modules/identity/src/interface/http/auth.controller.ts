import { Controller, Get, Req, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Auth,
  ApiCommonErrors,
  CurrentUser,
  AuthzService,
  SESSION_COOKIE,
  SelfScoped,
} from '@platform';
import type { JwtPayload } from '@platform';
import type { FastifyRequest, FastifyReply } from 'fastify';
import '@fastify/cookie';
import { EmployeeService } from '../../application/employee.service';
import { MeResponseDto } from './dto/auth.dto';
// `reply.generateCsrf` is a type augmentation contributed by @fastify/csrf-protection.
// The API registers that plugin in its bootstrap, but the WORKER build compiles this
// module too without ever touching the bootstrap — so without this type-only import the
// augmentation is absent from the worker's program and `nest build worker` fails with
// TS2339. Type-only: no runtime import is emitted.
import type {} from '@fastify/csrf-protection';

/**
 * What is left of `/v1/auth`: the SPA's single question, "who am I?".
 *
 * Signing in and out is identity 8's own surface, mounted at `/api/auth/*` (Better Auth: `sign-in/social`,
 * the Microsoft callback, `sign-out`); the Pages Function proxies it so it is same-origin with the SPA. The
 * v7 routes (`entra-login`, `dev-login`, `refresh`, `logout`, and the BFF under `/v1/bff`) are gone with the
 * JWT, the refresh token and the BFF session they served.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authz: AuthzService,
    private readonly employees: EmployeeService,
  ) {}

  @Get('me')
  @SelfScoped("returns the caller's own principal")
  @Auth()
  @ApiOperation({ summary: 'Return the authenticated principal and its effective permissions' })
  @ApiOkResponse({ type: MeResponseDto })
  @ApiCommonErrors(401)
  async me(
    @CurrentUser() user: JwtPayload,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<MeResponseDto> {
    // Effective permissions come from the DB (the single source of truth the
    // PolicyGuard also enforces). The SPA gates its UI on this list rather than
    // re-deriving permissions from role names, so FE and BE can never drift.
    const [effective, employee] = await Promise.all([
      this.authz.resolve(user.sub),
      this.employees.getById(user.sub),
    ]);
    const session = request.cookies?.[SESSION_COOKIE];
    return {
      sub: user.sub,
      email: user.email,
      name: user.name,
      // from the employee row (kept in step with the role assignments at every sign-in), not from a token
      roles: employee.roles,
      permissions: Object.keys(effective),
      // Minted here rather than from a dedicated endpoint: the SPA already calls this on
      // every start and page refresh, so the token's lifecycle matches the session's
      // with no extra round-trip, and `generateCsrf` plants the signed secret cookie on
      // the first call. Bound to the session cookie, so a token lifted from one session
      // cannot be replayed in another.
      csrfToken: session ? reply.generateCsrf({ userInfo: session }) : undefined,
    };
  }
}
