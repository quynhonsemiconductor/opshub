import { Global, Module } from '@nestjs/common';
import { AuditModule } from '@modules/audit';
import { AuthzModule } from '@modules/authz';
import { AppConfigService, BFF_SESSION_RESOLVER } from '@platform';
import {
  BFF_OPTIONS,
  BffService,
  BffSessionStore,
  EntraOidcClient,
  type BffOptions,
} from '@quynhonsemiconductor/identity';
import { EmployeeService } from './application/employee.service';
import { OpshubBffSessionResolver } from './application/bff-session.resolver';
import { EmployeesController } from './interface/http/employees.controller';
import { AuthController } from './interface/http/auth.controller';
import { BffController } from './interface/http/bff/bff.controller';
import { EmployeeDrizzleRepository } from './infrastructure/persistence/employee.drizzle-repository';
import { RefreshTokenDrizzleRepository } from './infrastructure/persistence/refresh-token.drizzle-repository';
import { EMPLOYEE_REPOSITORY } from './domain/ports/employee.repository';
import { REFRESH_TOKEN_REPOSITORY } from './domain/ports/refresh-token.repository';
import { sharedAuthProviders } from './infrastructure/shared-auth/shared-auth.providers';

/**
 * Identity module — employee directory + authentication.
 *
 * Authentication is delegated to the shared `@quynhonsemiconductor/identity` AuthService, wired to
 * opshub's concrete adapters via {@link sharedAuthProviders}. opshub keeps its own
 * `AuthController` (cookie shape + `/me` permission resolution) and its own JWT
 * strategy/guards; only the auth *service* is shared.
 *
 * Marked `@Global` so the `BFF_SESSION_RESOLVER` bridge it exports is visible to the
 * shared (also global) `JwtAuthGuard` singleton, which has to resolve a BFF session on
 * routes owned by every other module. Without that the guard would silently fall back to
 * Bearer-only on most of the API.
 */
@Global()
@Module({
  imports: [AuditModule, AuthzModule],
  controllers: [EmployeesController, AuthController, BffController],
  providers: [
    EmployeeService,
    { provide: EMPLOYEE_REPOSITORY, useClass: EmployeeDrizzleRepository },
    // Retained for employee offboarding (EmployeeService revokes all outstanding
    // refresh tokens); the shared AuthService uses its own AUTH_SESSION_REPOSITORY
    // binding over the same table.
    { provide: REFRESH_TOKEN_REPOSITORY, useClass: RefreshTokenDrizzleRepository },
    ...sharedAuthProviders,

    // ── BFF (Backend-for-Frontend): same-origin Entra OIDC session ─────────────
    // The mechanism lives in `@quynhonsemiconductor/identity` — the package exposes the pieces
    // rather than a module, so each product wires its own options and session store.
    // The multi-IdP broker collaborators (ConnectionRegistry, OidcClient,
    // OidcTokenVerifier) are deliberately NOT bound: they are `@Optional()` in
    // BffService, and opshub authenticates against a single company directory, so the
    // plain Entra path is the whole story. Binding them would require an
    // `sso_connections` table that has no reason to exist here.
    EntraOidcClient,
    BffSessionStore,
    BffService,
    OpshubBffSessionResolver,
    // The bridge the platform JwtAuthGuard consumes to authenticate a request from the
    // session cookie when no Bearer token is present.
    { provide: BFF_SESSION_RESOLVER, useExisting: OpshubBffSessionResolver },
    {
      provide: BFF_OPTIONS,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): BffOptions => ({
        // Gates the passwordless dev-login shortcut. Both deployed environments run
        // NODE_ENV=production, so it is off in develop too — see the controller.
        nodeEnv: config.get('NODE_ENV'),
        postLoginRedirect: config.get('BFF_POST_LOGIN_REDIRECT'),
        sessionTtlSeconds: config.get('BFF_SESSION_TTL_SECONDS'),
        entra: {
          tenantId: config.get('ENTRA_TENANT_ID') ?? '',
          clientId: config.get('ENTRA_CLIENT_ID') ?? '',
          // Empty until the app registration has a secret minted. The login START
          // still works; the callback's token exchange is what fails, and it fails
          // closed with a generic 401.
          clientSecret: config.get('ENTRA_CLIENT_SECRET') ?? '',
          redirectUri: config.get('ENTRA_REDIRECT_URI') ?? '',
        },
      }),
    },
  ],
  exports: [EmployeeService, BFF_SESSION_RESOLVER],
})
export class IdentityModule {}
