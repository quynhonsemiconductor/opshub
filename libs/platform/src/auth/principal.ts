/**
 * The authenticated principal attached to `request.user` by {@link SessionAuthGuard}.
 *
 * It is built from the identity 8 session (`session.user`): `sub` is the identity user id, which IS the
 * employee id (`identity.user.id = identity.employees.id`, see libs/modules/identity UserDirectory), so
 * every `user.sub` in the codebase keeps meaning the same person.
 *
 * The name `JwtPayload` is kept on purpose for this move: 44 files import it, and renaming it is a
 * mechanical change that does not belong in a security-sensitive diff. There is no JWT any more.
 *
 * `roles` is NOT filled here and is NOT for authorization: `PolicyGuard` resolves permissions from the
 * database on every request. `GET /v1/auth/me` returns the employee's roles from `employees.roles`.
 */
export interface JwtPayload {
  /** The employee id (= identity user id). */
  sub: string;
  email: string;
  name: string;
  /** Display only, and empty on a guard-built principal; `/v1/auth/me` reads it from the employee row. */
  roles: string[];
  /** The identity session id, for logs and audit. */
  sessionId?: string;
}
