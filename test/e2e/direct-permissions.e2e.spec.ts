/**
 * Permissions granted straight to one employee, outside any group — end to end.
 *
 * Group membership is how nearly everyone gets their permissions; this is the exception path, so what is
 * asserted here is the part that must hold against a real database and a real permission cache:
 *
 *   - a grant and its revocation take effect on the NEXT request, with no new sign-in;
 *   - a grant that EXPIRES stops granting when it says it does, not a cache lifetime later (the set is cached
 *     only until the earliest expiry in it);
 *   - the escalation rule: the grantor must hold the permission globally, so a holder of `group.assign` cannot
 *     use it to hand out something they do not have;
 *   - the grant needs a reason, a real permission, a real employee and an expiry that is still ahead;
 *   - a person who holds a permission through a group AND directly keeps it until BOTH are gone;
 *   - a reader (`rbac.read`) sees the grants and the reasons but cannot write.
 *
 * Offboarding's removal of direct grants is asserted in `offboarding-revocation.e2e.spec.ts`, next to the group
 * revocation it mirrors.
 *
 * The probe is `GET /v1/audit-logs`, which needs `audit.read`: held by `auditor`, not by the employee fixture.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d`, `pnpm db:migrate` and `pnpm db:seed`.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  FIXTURE,
  apiRequest,
  authHeaders,
  createTestApp,
  errorCode,
  login,
  unwrap,
  type ApiResponse,
  type Session,
} from './support/harness';

let app: NestFastifyApplication;
let admin: Session;
let auditor: Session;
let manager: Session;
/** Holds no permission codes at all — the person who is granted things in these tests. */
let employee: Session;

const _PROBE_ROUTE = '/v1/audit-logs';
const _PERMISSION_UNDER_TEST = 'audit.read';

/** Unique per run: custom group keys are global. */
const _RUN_TAG = Date.now().toString(36).slice(-6);

/** How long a short-lived grant lives, and how long the test waits past it, in milliseconds. */
const _SHORT_GRANT_MS = 4_000;
const _WAIT_PAST_EXPIRY_MS = 4_600;

interface GrantRow {
  id: string;
  permissionKey: string;
  reason: string;
}

/** Direct grants made by a test, removed afterwards so every test starts from the seed state. */
let createdGrantIds: string[] = [];
/** Group memberships made by a test, removed afterwards. */
let createdMembershipIds: string[] = [];

beforeAll(async () => {
  app = await createTestApp();
  admin = await login(app, FIXTURE.ADMIN);
  auditor = await login(app, FIXTURE.AUDITOR);
  manager = await login(app, FIXTURE.MANAGER);
  employee = await login(app, FIXTURE.NO_PERMISSIONS);
}, 60_000);

afterEach(async () => {
  for (const id of createdGrantIds) {
    await apiRequest(app, admin, 'DELETE', `/authz/employee-permissions/${id}`);
  }
  for (const id of createdMembershipIds) {
    await apiRequest(app, admin, 'DELETE', `/authz/employee-groups/${id}`);
  }
  createdGrantIds = [];
  createdMembershipIds = [];
});

afterAll(async () => {
  await app?.close();
});

function probe(): Promise<{ statusCode: number }> {
  return app.inject({ method: 'GET', url: _PROBE_ROUTE, headers: authHeaders(employee) });
}

/**
 * Grants a permission straight to the employee fixture, recording the grant for cleanup when it succeeds.
 *
 * Args:
 *   as: Who is granting.
 *   overrides: Fields to change in the request body; the default is `audit.read` with a reason.
 *
 * Returns:
 *   The API's response.
 */
async function grantDirect(
  as: Session,
  overrides: Record<string, unknown> = {},
): Promise<ApiResponse> {
  const response = await apiRequest(app, as, 'POST', '/authz/employee-permissions', {
    employeeId: FIXTURE.NO_PERMISSIONS.id,
    permissionKey: _PERMISSION_UNDER_TEST,
    reason: 'e2e: direct permission under test',
    ...overrides,
  });
  if (response.status === 201) createdGrantIds.push(unwrap<GrantRow>(response.body).id);
  return response;
}

describe('a permission granted directly', () => {
  it('takes effect on the next request and ends when it is revoked', async () => {
    expect((await probe()).statusCode).toBe(403);

    const granted = await grantDirect(admin);
    expect(granted.status, JSON.stringify(granted.body)).toBe(201);
    expect((await probe()).statusCode).toBe(200);

    const { id } = unwrap<GrantRow>(granted.body);
    const revoked = await apiRequest(app, admin, 'DELETE', `/authz/employee-permissions/${id}`);
    expect(revoked.status).toBe(204);
    expect((await probe()).statusCode).toBe(403);
  });

  it('stops granting when it expires, without waiting for the permission cache to lapse', async () => {
    /*
     * The permission set is cached for five minutes, and the expiry filter runs only when the cache is empty.
     * Before the cache was bounded by the earliest expiry in it, this grant would have kept answering 200 for
     * nearly five minutes after it had expired. The first probe fills the cache; the second, past the expiry,
     * must find it already gone.
     */
    const granted = await grantDirect(admin, {
      expiresAt: new Date(Date.now() + _SHORT_GRANT_MS).toISOString(),
    });
    expect(granted.status, JSON.stringify(granted.body)).toBe(201);
    expect((await probe()).statusCode).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, _WAIT_PAST_EXPIRY_MS));

    expect((await probe()).statusCode).toBe(403);
  }, 20_000);

  it('is kept by a group that grants the same permission until that membership goes too', async () => {
    const groups = unwrap<{ id: string; key: string }[]>(
      (await apiRequest(app, admin, 'GET', '/authz/groups')).body,
    );
    const auditorGroup = groups.find((g) => g.key === 'auditor');
    expect(auditorGroup, 'the seeded auditor group is missing').toBeDefined();

    const membership = await apiRequest(app, admin, 'POST', '/authz/employee-groups', {
      employeeId: FIXTURE.NO_PERMISSIONS.id,
      groupId: auditorGroup!.id,
    });
    expect(membership.status, JSON.stringify(membership.body)).toBe(201);
    const membershipId = unwrap<{ id: string }>(membership.body).id;
    createdMembershipIds.push(membershipId);
    const direct = await grantDirect(admin);
    expect(direct.status, JSON.stringify(direct.body)).toBe(201);

    // Revoke the direct grant: the group still grants it.
    await apiRequest(
      app,
      admin,
      'DELETE',
      `/authz/employee-permissions/${unwrap<GrantRow>(direct.body).id}`,
    );
    expect((await probe()).statusCode).toBe(200);

    // Remove the membership too: now it is gone.
    await apiRequest(app, admin, 'DELETE', `/authz/employee-groups/${membershipId}`);
    expect((await probe()).statusCode).toBe(403);
  });
});

describe('the form of a grant', () => {
  it('needs a reason', async () => {
    const response = await grantDirect(admin, { reason: '  ' });

    expect(response.status).toBe(422);
  });

  it('refuses a permission the catalogue does not define', async () => {
    const response = await grantDirect(admin, { permissionKey: 'no.such.permission' });

    expect(response.status).toBe(422);
    expect(errorCode(response.body)).toBe('PERMISSION_NOT_FOUND');
  });

  it('refuses an employee that does not exist', async () => {
    const response = await grantDirect(admin, {
      employeeId: '00000000-0000-4000-8000-00000000dead',
    });

    expect(response.status).toBe(404);
  });

  it('refuses an expiry that is already in the past', async () => {
    const response = await grantDirect(admin, {
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    expect(response.status).toBe(422);
  });
});

/**
 * Runs a body as the MANAGER fixture after giving them a custom group that carries `group.assign` and `asset.read`.
 *
 * The MANAGER fixture holds neither on its own, nor `audit.read`. `group.assign` is what lets them REACH the
 * endpoints; the no-escalation rule is what must stop them handing out something they do not hold. The group and
 * the membership are removed afterwards, along with anything the body granted.
 *
 * Args:
 *   run: The body to run once the manager holds the group.
 */
async function asAssigner(run: () => Promise<void>): Promise<void> {
  const created = await apiRequest(app, admin, 'POST', '/authz/groups', {
    key: `e2e-assigner-${_RUN_TAG}`,
    name: `E2E assigner ${_RUN_TAG}`,
    permissions: ['group.assign', 'asset.read'],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const groupId = unwrap<{ id: string }>(created.body).id;
  const membership = await apiRequest(app, admin, 'POST', '/authz/employee-groups', {
    employeeId: FIXTURE.MANAGER.id,
    groupId,
  });
  expect(membership.status, JSON.stringify(membership.body)).toBe(201);
  const membershipId = unwrap<{ id: string }>(membership.body).id;

  try {
    await run();
  } finally {
    for (const id of createdGrantIds) {
      await apiRequest(app, admin, 'DELETE', `/authz/employee-permissions/${id}`);
    }
    createdGrantIds = [];
    for (const id of createdMembershipIds) {
      await apiRequest(app, admin, 'DELETE', `/authz/employee-groups/${id}`);
    }
    createdMembershipIds = [];
    await apiRequest(app, admin, 'DELETE', `/authz/employee-groups/${membershipId}`);
    await apiRequest(app, admin, 'DELETE', `/authz/groups/${groupId}`);
  }
}

describe('who may grant', () => {
  it('stops a holder of group.assign handing out a permission they do not hold', async () => {
    await asAssigner(async () => {
      const refused = await grantDirect(manager, { permissionKey: 'audit.read' });
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);

      const allowed = await grantDirect(manager, { permissionKey: 'asset.read' });
      expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);
    });
  });

  it('stops a holder of group.assign putting someone in a group whose permissions they do not all hold', async () => {
    // The same rule on the other door: a membership hands out a group's WHOLE bundle, so the grantor must hold
    // every permission in it. `auditor` carries `audit.read`, which the MANAGER fixture lacks.
    const groups = unwrap<{ id: string; key: string }[]>(
      (await apiRequest(app, admin, 'GET', '/authz/groups')).body,
    );
    const auditorGroup = groups.find((g) => g.key === 'auditor');
    expect(auditorGroup, 'the seeded auditor group is missing').toBeDefined();

    await asAssigner(async () => {
      const refused = await apiRequest(app, manager, 'POST', '/authz/employee-groups', {
        employeeId: FIXTURE.NO_PERMISSIONS.id,
        groupId: auditorGroup!.id,
      });
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      // Nothing was handed out.
      expect((await probe()).statusCode).toBe(403);

      // A group whose bundle the grantor DOES hold may be handed out.
      const own = await apiRequest(app, admin, 'POST', '/authz/groups', {
        key: `e2e-readers-${_RUN_TAG}`,
        name: `E2E readers ${_RUN_TAG}`,
        permissions: ['asset.read'],
      });
      expect(own.status, JSON.stringify(own.body)).toBe(201);
      const ownId = unwrap<{ id: string }>(own.body).id;
      try {
        const allowed = await apiRequest(app, manager, 'POST', '/authz/employee-groups', {
          employeeId: FIXTURE.NO_PERMISSIONS.id,
          groupId: ownId,
        });
        expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);
      } finally {
        // Deleting the group cascades the membership.
        await apiRequest(app, admin, 'DELETE', `/authz/groups/${ownId}`);
      }
    });
  });

  it('lets a reader see the grants and their reasons, and nothing more', async () => {
    const granted = await grantDirect(admin, { reason: 'e2e: covering the audit desk' });
    expect(granted.status, JSON.stringify(granted.body)).toBe(201);

    const listed = await apiRequest(
      app,
      auditor,
      'GET',
      `/authz/employees/${FIXTURE.NO_PERMISSIONS.id}/permissions`,
    );
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(unwrap<GrantRow[]>(listed.body)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          permissionKey: _PERMISSION_UNDER_TEST,
          reason: 'e2e: covering the audit desk',
        }),
      ]),
    );

    const refused = await grantDirect(auditor);
    expect(refused.status).toBe(403);
  });
});
