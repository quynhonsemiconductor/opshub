/**
 * Raising a request tells the people who can decide it — and only them.
 *
 * WHAT WAS BROKEN. The engine notified `assigneeId` and nothing else, and no production path sets one:
 * no `RequestTypeDef` defines a `resolverFn`, no caller of `submit` passes `opts.assigneeId`. Measured
 * on a seeded database, 71 request rows had a single assignee between them and a test had written it.
 * So every real request was submitted in silence, and `request.step_ready` — guarded the same way —
 * had never been delivered once. An approver had to think to go and look.
 *
 * WHY THIS FILE EXISTS ALONGSIDE THE UNIT SPECS. `AuthzService.globalHoldersOf` decides who is told,
 * and the rule that makes it correct is SQL: `scope_type = 'global'` and a live expiry. A mocked
 * executor hands back whatever rows the test supplies, so deleting the scope filter passes every unit
 * assertion — the mutation SURVIVED before this was written. Only a real database can refuse it.
 *
 * The rule mirrors `check()` deliberately: with no resource to evaluate, a constrained grant DENIES,
 * so a team-scoped holder cannot approve an arbitrary request. Telling them one is waiting would be an
 * invitation to a 403.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d` and `pnpm db:seed`.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { AuthzService, DRIZZLE, type DrizzleDB } from '@platform';
import { roles, userRoleAssignments } from '../../db/schema';
import { FIXTURE, createTestApp } from './support/harness';

let app: NestFastifyApplication;
let authz: AuthzService;
let db: DrizzleDB;
/** The `hr` role carries `workforce.approve`; reused rather than inventing a role. */
let hrRoleId: string;
/** Holds nothing by default, so any grant it gets in this file is the one under test. */
const SUBJECT = FIXTURE.NO_PERMISSIONS.id;

beforeAll(async () => {
  app = await createTestApp();
  authz = app.get(AuthzService);
  db = app.get<DrizzleDB>(DRIZZLE);

  const [hr] = await db.select({ id: roles.id }).from(roles).where(eq(roles.key, 'hr')).limit(1);
  expect(hr, 'the seeded `hr` role is missing — run pnpm db:seed').toBeTruthy();
  hrRoleId = hr.id;

  await clearSubjectGrants();
}, 60_000);

afterAll(async () => {
  await clearSubjectGrants();
  await app?.close();
});

/** Leaves no assignment behind: a stray global grant would silently widen other specs. */
async function clearSubjectGrants(): Promise<void> {
  await db
    .delete(userRoleAssignments)
    .where(and(eq(userRoleAssignments.userId, SUBJECT), eq(userRoleAssignments.roleId, hrRoleId)));
}

/**
 * Grants the role, then PROVES the row is there.
 *
 * The readback is not ceremony. Three assertions below are `not.toContain`, and every one of them
 * passes just as happily if the insert never happened — so a mutation deleting the expiry filter
 * SURVIVED until this existed, because "excluded by the query" and "never stored" are the same
 * observation from outside. The row has to exist for its absence from the holders to mean anything.
 */
async function grant(scopeType: 'global' | 'team', expiresAt: Date | null): Promise<void> {
  await clearSubjectGrants();
  await db.insert(userRoleAssignments).values({
    userId: SUBJECT,
    roleId: hrRoleId,
    scopeType,
    scopeId: scopeType === 'global' ? null : 'team-alpha',
    // `granted_by` is NOT NULL — every grant records who made it, which is the point of the column.
    grantedBy: FIXTURE.ADMIN.id,
    expiresAt,
  });

  const stored = await db
    .select({ id: userRoleAssignments.id })
    .from(userRoleAssignments)
    .where(and(eq(userRoleAssignments.userId, SUBJECT), eq(userRoleAssignments.roleId, hrRoleId)));
  expect(stored, `the ${scopeType} grant under test was not stored`).toHaveLength(1);
}

describe('who is notified that a request needs deciding', () => {
  it('includes a GLOBAL holder of the step permission', async () => {
    await grant('global', null);
    const holders = await authz.globalHoldersOf('workforce.approve');
    expect(holders).toContain(SUBJECT);
  });

  it('EXCLUDES a team-scoped holder, because they could not approve it anyway', async () => {
    /*
     * The assertion a mocked database cannot make, and the one the surviving mutation broke. The grant
     * is real, stored, and accepted by the RBAC API — it is the SCOPE that disqualifies them.
     */
    await grant('team', null);
    const holders = await authz.globalHoldersOf('workforce.approve');
    expect(holders).not.toContain(SUBJECT);

    // And the reason is exactly the one `check` gives: no resource, constrained grant, denied.
    expect(await authz.check(SUBJECT, 'workforce.approve')).toBe(false);
  });

  it('EXCLUDES an expired global grant', async () => {
    await grant('global', new Date(Date.now() - 60_000));
    const holders = await authz.globalHoldersOf('workforce.approve');
    expect(holders).not.toContain(SUBJECT);
  });

  it('includes a global grant that has not expired yet', async () => {
    // The other side of the expiry boundary, so a mutation that drops the date comparison entirely
    // cannot pass by making every grant look expired.
    await grant('global', new Date(Date.now() + 3_600_000));
    const holders = await authz.globalHoldersOf('workforce.approve');
    expect(holders).toContain(SUBJECT);
  });

  it('finds the seeded approvers, so a broken query fails loudly', async () => {
    /*
     * The floor. Every assertion above except the first is a `not.toContain`, and all of them would
     * pass against a query that returns nothing at all — which is precisely how this check would die
     * without anyone noticing.
     */
    await clearSubjectGrants();
    const holders = await authz.globalHoldersOf('workforce.approve');
    expect(holders.length).toBeGreaterThanOrEqual(2);
    // The admin holds `*`, not `workforce.approve` — so this also proves wildcard coverage on real data.
    expect(holders).toContain(FIXTURE.ADMIN.id);
    expect(holders).toContain(FIXTURE.HR.id);
  });
});
