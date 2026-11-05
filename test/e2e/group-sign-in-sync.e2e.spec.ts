/**
 * What an SSO sign-in does to group memberships, against the real database.
 *
 * At every sign-in the App Roles of the id_token are reconciled into the employee's global group memberships.
 * That reconcile is right for what the identity provider granted and wrong for what a person granted by hand:
 * the general `approver` group is meant to be handed out in the admin UI, and a membership made there used to
 * be revoked at the person's next sign-in because the token did not name it. Memberships now record who made
 * them, and the reconcile takes back only the ones an earlier sign-in wrote.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d`, `pnpm db:migrate` and `pnpm db:seed`.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AuthzAdminService,
  EMPLOYEE_GROUP_REPOSITORY,
  GROUP_REPOSITORY,
  type Actor,
  type IEmployeeGroupRepository,
  type IGroupRepository,
} from '@modules/authz';
import { FIXTURE, createTestApp } from './support/harness';

let app: NestFastifyApplication;
let admin: AuthzAdminService;
let groups: IGroupRepository;
let memberships: IEmployeeGroupRepository;
/** Membership ids the fixture held before the suite, which it must leave exactly as it found them. */
let preExistingIds: Set<string>;

const _EMPLOYEE_ID = FIXTURE.NO_PERMISSIONS.id;

/** Who an admin is when they hand a group out in the UI. */
const _ADMIN: Actor = { sub: FIXTURE.ADMIN.id, email: FIXTURE.ADMIN.email };

/** Who the sign-in is: the person signing in acts for themselves, exactly as `StaffSignInHandler` passes it. */
const _SIGNING_IN: Actor = { sub: _EMPLOYEE_ID, email: FIXTURE.NO_PERMISSIONS.email };

/** The group the floor puts everyone in, with no permissions of its own. */
const _FLOOR_KEY = 'employee';

/** The group handed out by hand in these tests, and the one Entra asserts. */
const _HAND_GRANTED_KEY = 'approver';
const _IDP_GRANTED_KEY = 'auditor';

/** The employee's global memberships as `[group key, source]` pairs, sorted. */
async function holdings(): Promise<[string, string][]> {
  const byId = new Map((await groups.list()).map((g) => [g.id, g.key]));
  return (await memberships.listForEmployee(_EMPLOYEE_ID))
    .filter((m) => m.scopeType === 'global')
    .map((m): [string, string] => [byId.get(m.groupId) ?? m.groupId, m.source])
    .sort();
}

beforeAll(async () => {
  app = await createTestApp();
  admin = app.get(AuthzAdminService);
  groups = app.get<IGroupRepository>(GROUP_REPOSITORY);
  memberships = app.get<IEmployeeGroupRepository>(EMPLOYEE_GROUP_REPOSITORY);
  preExistingIds = new Set((await memberships.listForEmployee(_EMPLOYEE_ID)).map((m) => m.id));
}, 60_000);

afterAll(async () => {
  // Through the service, so the teardown also drops the cached permissions.
  for (const m of await memberships.listForEmployee(_EMPLOYEE_ID)) {
    if (!preExistingIds.has(m.id)) await admin.revokeEmployeeGroup(m.id, _ADMIN);
  }
  await app?.close();
});

describe('the sign-in reconcile and memberships granted by hand', () => {
  it('keeps a membership an admin granted, and revokes only what an earlier sign-in wrote', async () => {
    const handKey = _HAND_GRANTED_KEY;
    const handGroup = await groups.findByKey(handKey);
    expect(handGroup, `seeded \`${handKey}\` group missing — run pnpm db:migrate`).not.toBeNull();

    const byHand = await admin.assignGroup(
      {
        employeeId: _EMPLOYEE_ID,
        groupId: handGroup!.id,
        scopeType: 'global',
        scopeId: null,
        expiresAt: null,
      },
      _ADMIN,
    );
    expect(byHand.source, 'a membership made through the admin API is a person’s').toBe('manual');

    // Entra names `auditor`: it is granted, and marked as the identity provider's.
    await admin.syncEmployeeGroupsByKeys(_EMPLOYEE_ID, [_IDP_GRANTED_KEY], _SIGNING_IN, _FLOOR_KEY);
    const afterGrant = await holdings();
    expect(afterGrant).toContainEqual([_IDP_GRANTED_KEY, 'idp']);
    expect(afterGrant, 'the sign-in revoked a membership granted by hand').toContainEqual([
      handKey,
      'manual',
    ]);

    // Entra stops naming `auditor`: that one goes at the next sign-in; the hand-made one stays.
    await admin.syncEmployeeGroupsByKeys(_EMPLOYEE_ID, [], _SIGNING_IN, _FLOOR_KEY);
    const afterRemoval = await holdings();
    expect(afterRemoval.map(([key]) => key)).not.toContain(_IDP_GRANTED_KEY);
    expect(afterRemoval, 'the sign-in revoked a membership granted by hand').toContainEqual([
      handKey,
      'manual',
    ]);
  });
});
