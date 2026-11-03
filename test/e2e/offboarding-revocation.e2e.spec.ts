/**
 * Offboarding removes privilege, and leaves evidence that it did.
 *
 * `OffboardingTypeDef.onApprove` performs the five removals that end somebody's access — status,
 * roles, access grants, hardware, sessions — and it recorded NOTHING. Not `group.revoked`, not
 * `access_grant.revoked`, not `asset.unassigned`. Every one of those events is audited when a person
 * does it by hand, because the services that own those tables write the entry; this hook writes the
 * tables directly and so wrote no entry. An access-removal review saw a leaver whose privileges had
 * vanished with no record of who removed them or when — on the single path where that evidence matters
 * most, and the one ISO 27001 A.8 asks about by name.
 *
 * It also never invalidated the permission cache. `AuthzService` holds a resolved permission set for
 * 300 seconds, so for up to five minutes after being offboarded a leaver's requests were still
 * authorised against roles they no longer held.
 *
 * WHY AN E2E AND NOT ONLY THE UNIT SPEC. `offboarding.type-def.spec.ts` asserts the calls against a
 * mocked recorder, which proves the code asks for an entry. It cannot prove one ARRIVES: the resource
 * types and the brand-new `session.revoked` action have to survive `AuditService.recordChange` and the
 * repository insert, and a bad pair fails at runtime, not at compile time. So this drives the real
 * workflow over real HTTP and then reads the real audit log back.
 *
 * IT OFFBOARDS A THROWAWAY EMPLOYEE, NEVER A FIXTURE. Offboarding a seeded fixture would revoke its
 * sessions and roles for every spec that runs afterwards — the same cross-spec pollution that makes
 * `performance.e2e.spec.ts` fail on a database other specs have already touched.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d` and `pnpm db:seed`.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE, authHeaders, createTestApp, login, type Session } from './support/harness';

let app: NestFastifyApplication;
/** Holds `*`: creates the throwaway employee and assigns it a role to be stripped. */
let admin: Session;
/** Holds `offboarding.approve` — the tier that actually runs this workflow. */
let hr: Session;

/** The employee created for this spec, offboarded by it, and referenced by nothing else. */
let employeeId: string;
let assignmentId: string;
/** A permission granted to the leaver directly, outside any group: offboarding has to strip it too. */
let directGrantId: string;

beforeAll(async () => {
  app = await createTestApp();
  admin = await login(app, FIXTURE.ADMIN);
  hr = await login(app, FIXTURE.HR);
});

afterAll(async () => {
  await app?.close();
});

async function post(
  who: Session,
  url: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // Bearer only: the CSRF hook guards COOKIE sessions, and every e2e spec authenticates with a token.
  const res = await app.inject({ method: 'POST', url, headers: authHeaders(who), payload });
  expect(res.statusCode, `${url} → ${res.body}`).toBeLessThan(300);
  return JSON.parse(res.body) as Record<string, unknown>;
}

async function auditEntries(
  resourceType: string,
  resourceId: string,
): Promise<{ action: string; actorId: string; resourceId: string | null }[]> {
  const res = await app.inject({
    method: 'GET',
    url: `/v1/audit-logs?resourceType=${resourceType}&resourceId=${resourceId}&limit=50`,
    headers: authHeaders(admin),
  });
  expect(res.statusCode, res.body).toBe(200);
  // `data`, not `items`: that is the shape `buildPageResult` produces.
  return (
    JSON.parse(res.body) as {
      data: { action: string; actorId: string; resourceId: string | null }[];
    }
  ).data;
}

describe('offboarding leaves evidence', () => {
  it('offboards a throwaway employee through the real workflow', async () => {
    const unique = Date.now();
    const employee = await post(admin, '/v1/employees', {
      displayName: `E2E Leaver ${unique}`,
      email: `e2e-leaver-${unique}@opshub.local`,
      department: 'Engineering',
      jobTitle: 'Engineer',
      hireDate: '2026-01-05',
    });
    employeeId = employee.id as string;

    // A group to strip. Without one, "no group.revoked entry" would be true of a leaver who belonged to no
    // group, and the assertion below would pass against the unfixed code.
    const groups = await app.inject({
      method: 'GET',
      url: '/v1/authz/groups',
      headers: authHeaders(admin),
    });
    expect(groups.statusCode, groups.body).toBe(200);
    // A bare array, not a paged envelope — this route returns `GroupResponseDto[]`.
    const groupList = JSON.parse(groups.body) as { id: string; key: string }[];
    const helpdesk = groupList.find((g) => g.key === 'helpdesk');
    expect(helpdesk, 'the seeded helpdesk group is missing').toBeDefined();

    const assignment = await post(admin, '/v1/authz/employee-groups', {
      employeeId,
      groupId: helpdesk!.id,
    });
    assignmentId = assignment.id as string;

    // A permission outside any group, which removing the memberships alone would leave in the leaver's hands.
    const directGrant = await post(admin, '/v1/authz/employee-permissions', {
      employeeId,
      permissionKey: 'audit.read',
      reason: 'e2e: offboarding must strip direct grants too',
    });
    directGrantId = directGrant.id as string;

    /*
     * THE LEAVER SIGNS IN, so there is a session to revoke.
     *
     * A freshly created employee holds no session, and step 5 correctly records nothing when it
     * revokes nothing — so without this the `session.revoked` assertion below would fail against
     * CORRECT code, and pass against code that recorded the event unconditionally. The login is what
     * makes the absence meaningful.
     */
    await login(app, { email: employee.email as string });

    const submitted = await post(hr, '/v1/workforce/offboarding', {
      employeeId,
      reason: 'e2e: offboarding must leave an audit trail',
    });
    const requestId = submitted.requestId as string;

    // HR approves its own submission: `allowSelfApproval` is false, so this has to be a different
    // identity — the admin approves.
    await post(admin, `/v1/requests/${requestId}/approve`, { note: 'e2e' });
  });

  it('records the status change against the employee', async () => {
    const entries = await auditEntries('employee', employeeId);
    const actions = entries.map((e) => e.action);

    expect(actions, JSON.stringify(entries)).toContain('employee.status_changed');
    // The APPROVER, not the requester: they authorised the removal.
    const change = entries.find((e) => e.action === 'employee.status_changed');
    expect(change!.actorId).toBe(FIXTURE.ADMIN.id);
  });

  it('records the group revocation against the membership it removed', async () => {
    // Keyed on the ASSIGNMENT id, the same resource `AuthzAdminService.revokeEmployeeGroup` uses — so a
    // reviewer reading a group's history sees one shape whether it was revoked by hand or by a leaver.
    const entries = await auditEntries('employee_group', assignmentId);
    expect(
      entries.map((e) => e.action),
      JSON.stringify(entries),
    ).toContain('group.revoked');
  });

  it('strips the permissions granted directly, and records each one', async () => {
    const entries = await auditEntries('employee_permission', directGrantId);
    expect(
      entries.map((e) => e.action),
      JSON.stringify(entries),
    ).toContain('employee_permission.revoked');

    const remaining = await app.inject({
      method: 'GET',
      url: `/v1/authz/employees/${employeeId}/permissions`,
      headers: authHeaders(admin),
    });
    expect(remaining.statusCode, remaining.body).toBe(200);
    expect(JSON.parse(remaining.body)).toEqual([]);
  });

  it('records the forced logout as a revocation, not as a logout', async () => {
    const entries = await auditEntries('session', employeeId);
    const actions = entries.map((e) => e.action);

    // `session.revoked` is new in this change. If the action or the resource type did not survive the
    // insert, this is the assertion that fails — which the unit spec's mocked recorder cannot see.
    // The leaver signed in during the first test, so there was exactly one session to end.
    expect(actions, JSON.stringify(entries)).toContain('session.revoked');
    // `auth.logout` would attribute the act to the person it was done to.
    expect(actions).not.toContain('auth.logout');
  });

  it('leaves the employee with no roles and no live claims', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/employees/${employeeId}`,
      headers: authHeaders(admin),
    });
    expect(res.statusCode, res.body).toBe(200);
    const employee = JSON.parse(res.body) as { status: string; groups: string[] };

    expect(employee.status).toBe('offboarded');
    /*
     * `employees.group_keys` is the denormalised copy that feeds `/v1/auth/me`, and nothing maintained it
     * here — so an offboarded row still listed `helpdesk` after the assignment behind it was deleted.
     * A stale claim is not merely cosmetic: it is what a token is minted from.
     */
    expect(employee.groups, 'the denormalised group keys still list a revoked group').toEqual([]);
  });
});
