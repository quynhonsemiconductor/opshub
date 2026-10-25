/**
 * End-to-end proof that a permission change takes effect on the user's NEXT request — with
 * no re-login, and nothing for the client to do.
 *
 * The property under test is the ABSENCE of a snapshot. opshub's session carries
 * identity and NOTHING else (the roles shown by `/v1/auth/me` are read from `employees.roles`): `PolicyGuard` resolves
 * permissions from the database on every request, cached per user in Valkey and invalidated
 * by the write paths. So there is no embedded permission list to go stale, and no epoch
 * counter needed to expire one early — the same token simply gets a different answer.
 *
 * `authz-admin.service.spec.ts` already asserts that every write path CALLS
 * `authz.invalidate`, with a mocked AuthzService. What it cannot show is that the
 * invalidation actually reaches the cache the guard reads, which is the part that decides
 * whether a revocation is effective in one millisecond or in five minutes: `resolve` caches
 * for `CACHE_TTL_SECONDS = 300`. A `del` against the wrong key, or a second cache instance,
 * would leave that unit test green and revocation broken for the whole TTL.
 *
 * Probe route: `GET /v1/audit-logs`. Chosen because the controller carries a class-level
 * `@RequirePermission('audit.read')`, the handler takes no path parameters, and a
 * JIT-seeded `employee` holds nothing — so a non-200 can only come from the authorization
 * decision, not from a missing row or a bad id.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d` and `pnpm db:seed`.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  AuthzAdminService,
  ROLE_ASSIGNMENT_REPOSITORY,
  ROLE_REPOSITORY,
  type Actor,
  type IRoleAssignmentRepository,
  type IRoleRepository,
} from '@modules/authz';
import { DRIZZLE, type DrizzleDB, type RoleAssignment, type RoleWithPermissions } from '@platform';
import { eq } from 'drizzle-orm';
import { employees } from '../../db/schema';
import { FIXTURE, authHeaders, createTestApp, login, type Session } from './support/harness';

const PROBE_ROUTE = '/v1/audit-logs';

let app: NestFastifyApplication;
let admin: AuthzAdminService;
let db: DrizzleDB;
let roles: IRoleRepository;
let assignments: IRoleAssignmentRepository;
/** The `auditor` role — the smallest seeded bundle that includes `audit.read`. */
let auditorRole: RoleWithPermissions;
/** Session for the fixture that holds NO permissions. */
let victim: Session;

/**
 * Acting admin for the grant/revoke calls. `assertCanGrantRole` requires the actor's own
 * permissions to be a superset of the role being granted, so this must be the wildcard
 * holder — and `granted_by` is a real uuid column, so a synthetic id fails the insert.
 */
const ACTOR: Actor = { sub: FIXTURE.ADMIN.id, email: FIXTURE.ADMIN.email };

/** Assignments created by a test, torn down after it so each starts from the seed state. */
let created: RoleAssignment[] = [];

async function grantAuditor(
  overrides: { scopeType?: 'global' | 'self' | 'dept'; scopeId?: string; expiresAt?: Date } = {},
): Promise<RoleAssignment> {
  const assignment = await admin.assignRole(
    {
      userId: FIXTURE.NO_PERMISSIONS.id,
      roleId: auditorRole.id,
      scopeType: overrides.scopeType ?? 'global',
      scopeId: overrides.scopeId ?? null,
      expiresAt: overrides.expiresAt ?? null,
    },
    ACTOR,
  );
  created.push(assignment);
  return assignment;
}

function probe() {
  return app.inject({ method: 'GET', url: PROBE_ROUTE, headers: authHeaders(victim) });
}

/** The roles `/v1/auth/me` displays for a session: a DISPLAY list, read from `employees.roles`. */
async function displayedRoles(session: Session): Promise<string[]> {
  const res = await app.inject({
    method: 'GET',
    url: '/v1/auth/me',
    headers: { cookie: session.cookieHeader },
  });
  return res.json<{ roles: string[] }>().roles;
}

beforeAll(async () => {
  app = await createTestApp();
  admin = app.get(AuthzAdminService);
  db = app.get<DrizzleDB>(DRIZZLE);
  roles = app.get<IRoleRepository>(ROLE_REPOSITORY);
  assignments = app.get<IRoleAssignmentRepository>(ROLE_ASSIGNMENT_REPOSITORY);

  const auditor = await roles.findByKey('auditor');
  expect(auditor, 'seeded `auditor` role missing — run pnpm db:seed').not.toBeNull();
  expect(auditor!.permissions).toContain('audit.read');
  auditorRole = auditor!;

  victim = await login(app, FIXTURE.NO_PERMISSIONS);
}, 60_000);

afterEach(async () => {
  // Revoke through the SERVICE, not the repository, so the teardown also busts the cache —
  // a repository-level delete would leave the next test reading a stale grant and passing
  // for the wrong reason.
  for (const assignment of created) {
    await admin.revokeAssignment(assignment.id, ACTOR).catch(() => undefined);
  }
  created = [];
});

afterAll(async () => {
  await app?.close();
});

describe('permission changes take effect on the next request', () => {
  it('keeps no permission list in the session', async () => {
    // The absence IS the mechanism. While a session carries its own permission list, every
    // authorization answer is as old as the session, and something has to exist to expire it
    // early. The session cookie is an opaque id: `/v1/auth/me` RESOLVES the permissions it returns from
    // the database on each call, so they follow a grant without a new sign-in.
    const meBefore = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie: victim.cookieHeader },
    });
    expect(meBefore.json<{ permissions: string[] }>().permissions).not.toContain('audit.read');

    await grantAuditor();

    const meAfter = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie: victim.cookieHeader },
    });
    expect(meAfter.json<{ permissions: string[] }>().permissions).toContain('audit.read');
    expect(meAfter.json<Record<string, unknown>>()['authzEpoch']).toBeUndefined();
  });

  it('a GRANT takes effect on the same session, on the very next request', async () => {
    // 1. The fixture holds the `employee` role, whose permission bundle is empty by design.
    expect((await probe()).statusCode).toBe(403);

    // 2. The admin action that, with an embedded permission list, would have required the
    //    holder to refresh before it meant anything.
    await grantAuditor();

    // 3. Same session cookie, no re-login: allowed now. Immediately — the
    //    resolve cache has a 300s TTL, so without the write path's invalidate this stays
    //    403 for five minutes.
    expect((await probe()).statusCode).toBe(200);
  });

  it('a REVOCATION takes effect on the same session, on the very next request', async () => {
    const assignment = await grantAuditor();
    expect((await probe()).statusCode).toBe(200);

    await admin.revokeAssignment(assignment.id, ACTOR);
    created = created.filter((a) => a.id !== assignment.id);

    // 403, not 401: the token is still perfectly valid and authentication never became the
    // problem — it simply no longer authorizes this route. A 401 here would mean revocation
    // was implemented by breaking the session, which would log the user out of everything.
    const after = await probe();
    expect(after.statusCode).toBe(403);
  });

  it('does not authorize from the displayed roles list', async () => {
    // The strongest form of the property, and the reason the RoleGuard that read a roles array
    // was removed. `syncEmployeeRoleClaims` rewrites `employees.roles` on every grant, and
    // `/v1/auth/me` shows it. So write `auditor` there WITHOUT an assignment: the list says
    // auditor, the authorization decision must still say no.
    const before = await displayedRoles(victim);
    await db
      .update(employees)
      .set({ roles: [...before, 'auditor'] })
      .where(eq(employees.id, FIXTURE.NO_PERMISSIONS.id));
    try {
      expect(await displayedRoles(victim)).toEqual(expect.arrayContaining(['auditor']));
      expect((await probe()).statusCode).toBe(403);
    } finally {
      await db
        .update(employees)
        .set({ roles: before })
        .where(eq(employees.id, FIXTURE.NO_PERMISSIONS.id));
    }
  });

  it('an already-expired assignment grants nothing', async () => {
    // `resolve` filters on `expiresAt > now`, so a grant written with a past expiry must be
    // inert from the start rather than granting until someone notices.
    await grantAuditor({ expiresAt: new Date(Date.now() - 60_000) });
    expect((await probe()).statusCode).toBe(403);
  });

  it('a self-scoped grant does NOT satisfy a route that declares no scope', async () => {
    // opshub-specific, and the fail-closed rule that matters most: `AuthzService.check`
    // DENIES a constrained grant when the route declared no scope to verify it against.
    // This route is `@RequirePermission('audit.read')` with no descriptor, so a `self`
    // grant cannot be evaluated and must not pass.
    //
    // The direction that would be a silent disaster is the other one: this used to read
    // `if (!resource) return true`, which enforced every constrained grant as if it were
    // global. An operator could scope someone to `self` through the RBAC API — which
    // validates and stores the scope — and the holder would read everything.
    await grantAuditor({ scopeType: 'self' });
    expect((await probe()).statusCode).toBe(403);
  });

  it('a dept-scoped grant also does not satisfy an unscoped route', async () => {
    await grantAuditor({ scopeType: 'dept', scopeId: 'Engineering' });
    expect((await probe()).statusCode).toBe(403);
  });

  it('records the grant as a global-scoped assignment row', async () => {
    // Structural, and narrower than it first looked: the roles[] claim sync is already
    // covered by the stale-claim test above, which logs in fresh and reads the token. This
    // asserts only that the row landed with the scope that was asked for — a grant silently
    // written as `self` would make every check above fail closed for a reason no assertion
    // would name.
    await grantAuditor();

    const rows = await assignments.listForUser(FIXTURE.NO_PERMISSIONS.id);
    expect(rows.some((r) => r.roleId === auditorRole.id && r.scopeType === 'global')).toBe(true);
  });

  it('still rejects an unauthenticated probe', async () => {
    // Anchors the 403s above: they are authorization answers, from a route that does
    // demand authentication.
    const res = await app.inject({ method: 'GET', url: PROBE_ROUTE });
    expect(res.statusCode).toBe(401);
  });
});
