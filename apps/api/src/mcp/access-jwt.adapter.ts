import { Logger } from '@nestjs/common';
import { and, ne, sql } from 'drizzle-orm';
import {
  AccessJwtError,
  type AccessPrincipal,
  createAccessJwtVerifier,
  type AccessJwtVerifier,
} from '@quynhonsemiconductor/identity/access-jwt';
import type { DrizzleDB } from '@platform';
import { employees } from '../../../../db/schema';
import type { McpAccessPrincipal, McpAccessVerifier } from './access-verifier';

/**
 * The real MCP access adapter, on identity 8.5's `access-jwt` verifier — the origin side of
 * MCP-PLAN §5, as constrained by the P0 spike (2026-10-23):
 *
 *  - the token is verified FULLY and pinned: RS256 against the team JWKS, `iss` = the team
 *    domain, `aud` = the MCP Access application's AUD tag (config, never hardcoded), `exp`+`nbf`;
 *  - `exp` equals the Access GRANT SESSION (planned 24 h), so it is NOT a freshness signal:
 *    on EVERY request the employee is resolved from the token's `email` (trimmed and lowercased,
 *    the same normaliser `UserDirectory.findByEmail` and `uq_employee_email_lower` use) and
 *    refused unless the row is an employee who has not been offboarded;
 *  - opshub has no workspace: the employee IS the principal, and `PolicyGuard` resolves every
 *    permission from the database per request. Nothing is copied from the token but the email;
 *  - the Entra `oid` claim is absent today and is NOT required (`allowEmailFallback` on);
 *  - an unknown or offboarded employee is a uniform 403 ({@link McpAccessDeniedError}), logged
 *    with the Access `sub` and a stable reason code — never the email, never distinguishing
 *    unknown from offboarded, and NEVER auto-provisioned from an MCP call.
 */
export class McpAccessDeniedError extends Error {
  constructor() {
    super('the Access token does not name an active employee');
    this.name = 'McpAccessDeniedError';
  }
}

/** Stable refusal reasons for the log (never the email, never unknown-vs-offboarded). */
type DenyReason = 'no_email_claim' | 'no_active_employee';

export interface McpAccessJwtAdapterOptions {
  db: DrizzleDB;
  /** The Access team domain as an origin (`https://<team>.cloudflareaccess.com`); `iss` must equal it. */
  teamDomain: string;
  /** The MCP Access application's AUD tag. */
  audience: string;
  logger?: Logger;
}

/**
 * Builds the adapter: identity's verifier for the cryptography, one DB read per request for the
 * person. Verifier construction fails fast on a bad config.
 */
export function createMcpAccessJwtAdapter(opts: McpAccessJwtAdapterOptions): McpAccessVerifier {
  const logger = opts.logger ?? new Logger('McpAccessJwt');
  const accessJwt: AccessJwtVerifier = createAccessJwtVerifier({
    teamDomain: opts.teamDomain,
    audience: opts.audience,
    // The `oid` claim does not reach the origin today (spike gate (d) failed): fall back to the
    // token's IdP-verified email. The email is the mapping key regardless.
    allowEmailFallback: true,
  });

  return {
    async verify(bearer: string): Promise<McpAccessPrincipal | null> {
      let principal: AccessPrincipal;
      try {
        principal = await accessJwt.verify(bearer);
      } catch (err) {
        // Inverted on purpose: ONLY jwks_unavailable is availability (rethrown → the route's 503).
        // Every other verifier error is a bad token → one uniform 401.
        if (err instanceof AccessJwtError && err.code === 'jwks_unavailable') throw err;
        return null;
      }

      // NOT a freshness signal, `exp`: resolve the employee NOW, on every request.
      const email = principal.email?.trim().toLowerCase();
      if (!email) return deny(logger, principal.sub, 'no_email_claim');
      const [employee] = await opts.db
        .select({ id: employees.id, email: employees.email, name: employees.displayName })
        .from(employees)
        .where(
          and(
            sql`lower(${employees.email}) = ${email}`,
            // `on_leave` is still an employee; only an offboarded row is refused. Offboarding also
            // bans the identity user in the same transaction, so identity's ban check is a second
            // gate on the injected request.
            ne(employees.status, 'offboarded'),
          ),
        )
        .limit(1);
      if (!employee) return deny(logger, principal.sub, 'no_active_employee');

      return { userId: employee.id, email: employee.email, name: employee.name };
    },
  };
}

/** One uniform 403: logged as `{ accessSub, reason }` — never the email, never a distinction. */
function deny(logger: Logger, sub: string, reason: DenyReason): never {
  logger.warn({ accessSub: sub, reason }, 'MCP access denied');
  throw new McpAccessDeniedError();
}
