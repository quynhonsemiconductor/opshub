import { Logger } from '@nestjs/common';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
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
 *  - the FIRST verified `sub` is BOUND to the employee (`identity.employees.access_sub`, nullable,
 *    unique) and every later call must match it. Email is the lookup key but can be reassigned, so
 *    a different Access identity reaching the same address is refused rather than inheriting the
 *    grants — the same fix KB made in kb#388. rova still has this gap; noted, not changed here;
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
type DenyReason = 'no_email_claim' | 'no_active_employee' | 'access_sub_mismatch';

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
        .select({
          id: employees.id,
          email: employees.email,
          name: employees.displayName,
          accessSub: employees.accessSub,
        })
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

      await bindAccessSub(opts.db, employee, principal.sub, logger);

      return { userId: employee.id, email: employee.email, name: employee.name };
    },
  };
}

/**
 * Drizzle WRAPS driver errors in `DrizzleQueryError`, so the pg code is on `.cause` — a check
 * against `err.code` alone never matches and turns a unique violation into a 500.
 */
function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  while (current !== null && current !== undefined) {
    if (typeof current === 'object' && 'code' in current) {
      if ((current as Record<string, unknown>).code === '23505') return true;
    }
    current =
      typeof current === 'object' && 'cause' in current
        ? (current as Record<string, unknown>).cause
        : undefined;
  }
  return false;
}

/**
 * The first verified `sub` wins, atomically. A concurrent first call for the same employee is
 * settled by the conditional UPDATE: exactly one writes, the other re-reads the winner and must
 * match it. A `sub` already bound elsewhere hits the unique index (23505) and is refused the same
 * way. Any other database error is infrastructure and propagates (the route answers 503).
 */
async function bindAccessSub(
  db: DrizzleDB,
  employee: { id: string; accessSub: string | null },
  sub: string,
  logger: Logger,
): Promise<void> {
  if (employee.accessSub === sub) return;
  if (employee.accessSub !== null) deny(logger, sub, 'access_sub_mismatch');

  try {
    const [bound] = await db
      .update(employees)
      .set({ accessSub: sub })
      .where(and(eq(employees.id, employee.id), isNull(employees.accessSub)))
      .returning({ id: employees.id });
    if (bound) return;
  } catch (err) {
    // 23505 (however deeply Drizzle wrapped it): this sub is already bound to a DIFFERENT
    // employee. Re-read decides below; every other error is availability, not a refusal.
    if (!isUniqueViolation(err)) throw err;
  }

  const [current] = await db
    .select({ accessSub: employees.accessSub })
    .from(employees)
    .where(eq(employees.id, employee.id))
    .limit(1);
  if (current?.accessSub !== sub) deny(logger, sub, 'access_sub_mismatch');
}

/** One uniform 403: logged as `{ accessSub, reason }` — never the email, never a distinction. */
function deny(logger: Logger, sub: string, reason: DenyReason): never {
  logger.warn({ accessSub: sub, reason }, 'MCP access denied');
  throw new McpAccessDeniedError();
}
