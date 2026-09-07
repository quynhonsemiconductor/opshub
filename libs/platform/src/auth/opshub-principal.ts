import type { JwtPayload as SharedJwtPayload } from '@quynhonsemiconductor/identity';
import type { JwtPayload } from './jwt.strategy';

/** The nested authorization claims opshub's `RolesClaimsProvider` stamps at mint time. */
interface OpshubClaims {
  roles?: string[];
  email?: string;
  name?: string;
}

/**
 * Flatten the shared package's payload onto opshub's request principal.
 *
 * The access token is minted by `@quynhonsemiconductor/identity`, so it carries the package's shape:
 * a nested `claims` bag alongside `sub`/`jti`/`sessionId`. Guards, controllers and the
 * audit context all read `email`, `name` and `roles` directly, so the flattening happens
 * once, here.
 *
 * Extracted because there are now TWO authentication paths that must produce an
 * identical principal — the Bearer path in `JwtStrategy.validate()` and the BFF session
 * path in the product's session resolver. Two copies of this mapping would drift, and
 * the failure would be quiet: a session-authenticated request whose `email` is empty
 * still authenticates, it just audits and logs as nobody.
 *
 * `roles` is carried for display and for the Entra reconcile, NOT for authorization —
 * `PolicyGuard` resolves permissions from the database on every request. Do not gate
 * anything on this array: it is a mint-time snapshot, which is why the RoleGuard that
 * read it was removed.
 */
export function toOpshubPrincipal(payload: SharedJwtPayload): JwtPayload {
  const claims = (payload.claims ?? {}) as OpshubClaims;
  return {
    ...payload,
    roles: claims.roles ?? [],
    email: claims.email ?? '',
    name: claims.name ?? '',
  };
}
