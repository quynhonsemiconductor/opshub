import {
  createIdentity,
  type Identity,
  type SecurityEventSink,
} from '@quynhonsemiconductor/identity';
import {
  identityLoggerFrom,
  observabilitySecurityEvents,
} from '@quynhonsemiconductor/identity/nest';
import type { CacheService } from '@quynhonsemiconductor/platform-cache';
import { failOpenLog } from '@quynhonsemiconductor/observability';
import type { PinoLogger } from 'nestjs-pino';
import { IDENTITY_PRODUCT, type AppConfigService, type DrizzleDB } from '@platform';
import * as identityAuthSchema from '../../../../../../db/schema/identity-auth';
import { STAFF_EMAIL_DOMAINS } from './staff-domains';
import type { StaffSignInHandler } from './staff-sign-in.handler';

const UNCONFIGURED_ID = '00000000-0000-4000-8000-000000000000';

export interface OpshubIdentityDeps {
  config: AppConfigService;
  db: DrizzleDB;
  cache: CacheService;
  staffSignIn: StaffSignInHandler;
  auditSink: SecurityEventSink;
  logger: PinoLogger;
  /**
   * The Entra authority (default `https://login.microsoftonline.com`). For the end-to-end sign-in suite, which
   * points it at identity's mock IdP; deliberately a code parameter and NOT an environment variable, so no
   * deployment can be configured to trust another login host.
   */
  staffAuthority?: string;
}

/**
 * THE one place opshub builds identity 8 (`createIdentity`): the `staff` preset only, Microsoft Entra,
 * single-tenant, no B2B guests. Nothing else in the repository imports the factory, and nothing imports
 * `better-auth` at all (identity pins it; one place to upgrade, every bump runs identity's conformance kit).
 *
 *  - `baseURL`/`trustedOrigins` are the SPA origin (`APP_URL`): the browser reaches `/api/auth/*` through the
 *    Pages Function on that origin, so the session cookie is set on the host the SPA uses, and Entra's
 *    redirect URI is `<APP_URL>/api/auth/callback/microsoft`.
 *  - No `mail`: the staff preset sends none (identity >= 8.1 makes it optional).
 *  - Entra settings may be absent in development and CI (`test-login` signs in); the env schema refuses that in
 *    production, so the placeholders below can never serve a real sign-in. An empty value counts as absent (`||`,
 *    not `??`): an `ENTRA_CLIENT_ID=` line in `.env` reads as an empty string.
 *  - `events`: the metric and log line identity provides, plus the audit log for sign-ins.
 */
export function createOpshubIdentity(deps: OpshubIdentityDeps): Identity {
  const { config, logger } = deps;
  const appUrl = config.get('APP_URL');
  const metrics = observabilitySecurityEvents(logger);
  const events: SecurityEventSink = {
    emit: async (event) => {
      await metrics.emit(event);
      await deps.auditSink.emit(event);
    },
  };
  return createIdentity({
    product: IDENTITY_PRODUCT,
    db: deps.db,
    schema: identityAuthSchema,
    cache: deps.cache,
    baseURL: appUrl,
    trustedOrigins: [appUrl],
    presets: ['staff'],
    staff: {
      tenantId: config.get('ENTRA_TENANT_ID') || UNCONFIGURED_ID,
      clientId: config.get('ENTRA_CLIENT_ID') || UNCONFIGURED_ID,
      clientSecret: config.get('ENTRA_CLIENT_SECRET') || 'unconfigured',
      domains: [...STAFF_EMAIL_DOMAINS],
      allowGuests: false,
      ...(deps.staffAuthority ? { authority: deps.staffAuthority } : {}),
    },
    hooks: {
      onStaffSignIn: (user, claims) => deps.staffSignIn.handle({ user, claims }),
    },
    events,
    logger: identityLoggerFrom(logger),
    // Valkey failing under identity: sessions fall back to Postgres (safe), but the per-IP sign-in rate limit
    // (`increment`) FAILS OPEN, which is exactly what the rate_limit fail-open alarm exists to show.
    onStorageDegraded: (operation, error) =>
      logger.warn(
        {
          ...(operation === 'increment' ? failOpenLog('rate_limit') : {}),
          source: 'identity',
          operation,
          error: error instanceof Error ? error.name : 'unknown',
        },
        'identity session cache degraded',
      ),
    testLogin: config.get('IDENTITY_TEST_LOGIN') === 'enabled',
    env: {
      ...process.env,
      NODE_ENV: config.get('NODE_ENV'),
      BETTER_AUTH_SECRET: config.get('BETTER_AUTH_SECRET'),
      ...(config.get('IDENTITY_TEST_LOGIN')
        ? { IDENTITY_TEST_LOGIN: config.get('IDENTITY_TEST_LOGIN') }
        : {}),
    },
  });
}
