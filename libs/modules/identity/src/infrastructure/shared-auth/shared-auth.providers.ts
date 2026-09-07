import { type Provider } from '@nestjs/common';
import { AppConfigService } from '@platform';
import {
  AUDIT_SERVICE,
  AUTH_SERVICE_OPTIONS,
  AUTH_SESSION_REPOSITORY,
  AuthService,
  CLAIMS_PROVIDER,
  ENTRA_VERIFIER_OPTIONS,
  EntraTokenVerifier,
  SSO_PROVISIONING_HOOK,
  TRANSACTION_RUNNER,
  USER_REPOSITORY,
  type AuthServiceOptions,
  type EntraVerifierOptions,
} from '@quynhonsemiconductor/identity';
import { AuditServiceAdapter } from './audit-service.adapter';
import { AuthSessionDrizzleRepository } from './auth-session.drizzle-repository';
import { DrizzleTransactionRunner } from './drizzle-transaction.runner';
import { EntraRoleProvisioningHook } from './entra-role-provisioning.hook';
import { RolesClaimsProvider } from './roles-claims.provider';
import { UserDrizzleRepository } from './user.drizzle-repository';

/**
 * Wires opshub's concrete adapters onto the shared `@quynhonsemiconductor/identity`
 * AuthService's collaborator ports, plus the two option factories and the
 * package's `EntraTokenVerifier` / `AuthService`. `AuthTokenCache` and
 * `JwtService` are provided globally (CacheModule / PlatformModule) and are not
 * repeated here. opshub is single-tenant, so the workspace-only ports
 * (`SSO_CONNECTION_REPOSITORY`, `ACCESS_SERVICE`, `WORKSPACE_SERVICE`) are left
 * unbound — the shared AuthService treats them as `@Optional()`.
 */
export const sharedAuthProviders: Provider[] = [
  UserDrizzleRepository,
  AuthSessionDrizzleRepository,
  DrizzleTransactionRunner,
  RolesClaimsProvider,
  AuditServiceAdapter,
  EntraRoleProvisioningHook,
  { provide: USER_REPOSITORY, useExisting: UserDrizzleRepository },
  { provide: AUTH_SESSION_REPOSITORY, useExisting: AuthSessionDrizzleRepository },
  { provide: TRANSACTION_RUNNER, useExisting: DrizzleTransactionRunner },
  { provide: CLAIMS_PROVIDER, useExisting: RolesClaimsProvider },
  { provide: AUDIT_SERVICE, useExisting: AuditServiceAdapter },
  { provide: SSO_PROVISIONING_HOOK, useExisting: EntraRoleProvisioningHook },
  {
    provide: AUTH_SERVICE_OPTIONS,
    inject: [AppConfigService],
    useFactory: (config: AppConfigService): AuthServiceOptions => ({
      jwtAccessExpiry: config.get('JWT_ACCESS_EXPIRY'),
      jwtRefreshExpiry: `${config.get('JWT_REFRESH_EXPIRY_DAYS')}d`,
      platformAdminEmails: [],
      nodeEnv: config.get('NODE_ENV'),
    }),
  },
  {
    provide: ENTRA_VERIFIER_OPTIONS,
    inject: [AppConfigService],
    useFactory: (config: AppConfigService): EntraVerifierOptions => ({
      tenantId: config.get('ENTRA_TENANT_ID') ?? '',
      clientId: config.get('ENTRA_CLIENT_ID') ?? '',
    }),
  },
  EntraTokenVerifier,
  AuthService,
];
