import { Global, Module } from '@nestjs/common';
import { IdentityModule } from '@quynhonsemiconductor/identity/nest';
import { PinoLogger } from 'nestjs-pino';
import { CacheService } from '@quynhonsemiconductor/platform-cache';
import {
  ApiConfigService,
  DRIZZLE,
  SESSION_REVOKER,
  UserRateLimitModule,
  type DrizzleDB,
} from '@platform';
import { AuditModule } from '@modules/audit';
import { AuthzModule } from '@modules/authz';
import { EmployeesModule } from './employees.module';
import { AuthController } from './interface/http/auth.controller';
import { createOpshubIdentity } from './infrastructure/auth/create-opshub-identity';
import { IdentitySessionRevoker } from './infrastructure/auth/identity-session-revoker';
import { SecurityEventAuditSink } from './infrastructure/auth/security-events.audit';
import { StaffSignInHandler } from './infrastructure/auth/staff-sign-in.handler';

/** What the identity factory needs from the application, in a module `forRootAsync` can import. */
@Module({
  imports: [AuditModule, AuthzModule],
  providers: [StaffSignInHandler, SecurityEventAuditSink],
  exports: [StaffSignInHandler, SecurityEventAuditSink],
})
class IdentityBindingsModule {}

/**
 * Authentication on identity 8 (Better Auth, the `staff` preset, Microsoft Entra). API ONLY: the worker has
 * no HTTP server and never imports this module.
 *
 * `IdentityModule.forRootAsync` builds the instance once (`createOpshubIdentity`), mounts its handler on
 * `/api/auth/*` as an encapsulated Fastify plugin, and registers identity's `SessionGuard` globally
 * (`APP_GUARD`): every route needs a session unless it is `@Public()`. opshub's `SessionAuthGuard` (route-level,
 * mounted by `@Auth()` / `@RequirePermission()`) then turns that session into the request principal.
 *
 * Global so `SESSION_REVOKER`, which the employee service and the offboarding workflow use, resolves wherever
 * they are compiled; the worker simply has no provider for it.
 */
@Global()
@Module({
  imports: [
    EmployeesModule,
    IdentityBindingsModule,
    IdentityModule.forRootAsync({
      imports: [IdentityBindingsModule],
      inject: [
        ApiConfigService,
        DRIZZLE,
        CacheService,
        StaffSignInHandler,
        SecurityEventAuditSink,
        PinoLogger,
      ],
      useFactory: (
        config: ApiConfigService,
        db: DrizzleDB,
        cache: CacheService,
        staffSignIn: StaffSignInHandler,
        auditSink: SecurityEventAuditSink,
        logger: PinoLogger,
      ) => createOpshubIdentity({ config, db, cache, staffSignIn, auditSink, logger }),
    }),
    // HERE, in the same module as IdentityModule and after it. Nest runs global guards in depth-first import order: a
    // per-user bucket in AppModule, imported before AuthModule, ran BEFORE identity's SessionGuard and never saw the
    // principal. Keep it below IdentityModule.forRootAsync; test/e2e/rate-limit-buckets.e2e.spec.ts asserts the order.
    UserRateLimitModule,
  ],
  controllers: [AuthController],
  providers: [{ provide: SESSION_REVOKER, useClass: IdentitySessionRevoker }],
  exports: [SESSION_REVOKER],
})
export class AuthModule {}
