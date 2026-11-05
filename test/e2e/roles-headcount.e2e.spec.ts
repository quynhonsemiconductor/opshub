/**
 * Roles, approved headcount and occupancy over time — end to end.
 *
 * WHAT THIS EXISTS TO PIN
 * -----------------------
 * `employees.job_title` is free text on the person, so before this module the org structure could
 * not be queried at all: no approved headcount, no vacancy, no record of what someone held two
 * years ago. Every rule the module adds is invisible from a single row, so each needs a flow:
 *
 *   - ONE CURRENT ROLE per employee — `uq_employee_current_role`, a partial unique index.
 *     Only a real Postgres can prove it, which is why this file exists at all.
 *   - a transfer is ONE act: the outgoing assignment closes and the incoming one opens together,
 *     so an employee is never briefly role-less and never briefly in two
 *   - approved HEADCOUNT is a ceiling on OPEN assignments, not on rows
 *   - occupancy (`filled`, `vacancies`) counts open assignments only — someone who left last month
 *     does not hold a seat
 *   - a `frozen` role keeps its occupants and accepts nobody new
 *   - an assignment cannot END BEFORE IT BEGAN, and the refusal is a 412, not the 500 a bare
 *     `ck_employee_role_window` violation produces. Found by probing the live API.
 *   - `role.read` is not `role.manage`
 *
 * CODES AND DEPARTMENTS ARE UNIQUE PER RUN. `uq_role_code` is global and the database is shared
 * with the other suites and not reset between them, so a fixed code makes a spec that passes once.
 * The department is per-run too, because the occupancy assertions list BY department and another
 * run's rows in the same department would change the count.
 *
 * ASSIGNMENTS USE THE SEEDED FIXTURES, whose current role this suite MOVES. That is safe only
 * because it is also the only suite that touches `roles`, and it is why the specs assert on
 * relative history ("the row it just closed") rather than on absolute history length.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d`, `pnpm db:migrate` and `pnpm db:seed`.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FIXTURE,
  apiRequest,
  createTestApp,
  errorCode,
  login,
  unwrap,
  type Session,
} from './support/harness';

let app: NestFastifyApplication;
/** Holds `role.read` AND `role.manage`. */
let hr: Session;
/** Holds `role.read` only — the tier that separates the read half from the manage half. */
let manager: Session;
/** Holds no permission codes at all. */
let employee: Session;

/** Unique per run: `uq_role_code` is global and the database is shared between suites. */
const RUN = Date.now().toString(36).toUpperCase().slice(-6);
const DEPARTMENT = `E2E-DEPT-${RUN}`;
let seq = 0;
const nextCode = (): string => `E2E-${RUN}-${++seq}`;

interface RoleRow {
  id: string;
  code: string;
  title: string;
  headcount: number;
  filled: number;
  vacancies: number;
  status: string;
}
interface AssignmentRow {
  id: string;
  employeeId: string;
  /** Resolved on the READ of a role's assignments; absent on the write shapes, by design. */
  employeeName?: string | null;
  roleId: string;
  /** History rows only — see the `roles/me` test for why the join exists. */
  roleCode?: string;
  roleTitle?: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  endReason: string | null;
}

/** `data` for wrapped responses, the payload itself otherwise. */

async function createRole(headcount: number): Promise<RoleRow> {
  const { status, body } = await apiRequest(app, hr, 'POST', '/roles', {
    code: nextCode(),
    title: 'E2E Engineer',
    department: DEPARTMENT,
    headcount,
  });
  expect(status).toBe(201);
  return unwrap<RoleRow>(body);
}

/** The row for one role out of the department listing, with its occupancy counts. */
async function occupancyOf(roleId: string): Promise<RoleRow> {
  const { status, body } = await apiRequest(
    app,
    hr,
    'GET',
    `/roles?department=${DEPARTMENT}&limit=100`,
  );
  expect(status).toBe(200);
  const row = unwrap<RoleRow[]>(body).find((p) => p.id === roleId);
  if (!row) throw new Error(`role ${roleId} missing from the ${DEPARTMENT} listing`);
  return row;
}

async function assign(
  roleId: string,
  employeeId: string,
  effectiveFrom: string,
): Promise<{ status: number; body: unknown }> {
  return apiRequest(app, hr, 'POST', `/roles/${roleId}/assignments`, {
    employeeId,
    effectiveFrom,
  });
}

async function historyOf(employeeId: string): Promise<AssignmentRow[]> {
  const { status, body } = await apiRequest(
    app,
    hr,
    'GET',
    `/roles/employees/${employeeId}/history`,
  );
  expect(status).toBe(200);
  return unwrap<AssignmentRow[]>(body);
}

beforeAll(async () => {
  app = await createTestApp();
  hr = await login(app, FIXTURE.HR);
  manager = await login(app, FIXTURE.MANAGER);
  employee = await login(app, FIXTURE.NO_PERMISSIONS);
}, 60_000);

afterAll(async () => {
  await app?.close();
});

describe('the role catalogue', () => {
  it('refuses a duplicate code', async () => {
    const code = nextCode();
    const first = await apiRequest(app, hr, 'POST', '/roles', {
      code,
      title: 'First',
      department: DEPARTMENT,
    });
    expect(first.status).toBe(201);

    const second = await apiRequest(app, hr, 'POST', '/roles', {
      code,
      title: 'Second',
      department: DEPARTMENT,
    });
    expect(second.status).toBe(409);
  });

  it('rejects a headcount below 1', async () => {
    // `ck_role_headcount_positive` in the database, the DTO here: a role permitting nobody
    // is a CLOSED role, which is what `status` is for.
    const { status } = await apiRequest(app, hr, 'POST', '/roles', {
      code: nextCode(),
      title: 'Zero',
      department: DEPARTMENT,
      headcount: 0,
    });
    expect(status).toBe(422);
  });
});

describe('occupancy', () => {
  it('counts open assignments only, and a closed one frees the seat', async () => {
    const role = await createRole(2);
    expect(await occupancyOf(role.id)).toMatchObject({ filled: 0, vacancies: 2 });

    const created = await assign(role.id, FIXTURE.NO_PERMISSIONS.id, '2030-01-01');
    expect(created.status).toBe(201);
    const assignment = unwrap<AssignmentRow>(created.body);
    expect(await occupancyOf(role.id)).toMatchObject({ filled: 1, vacancies: 1 });

    const ended = await apiRequest(app, hr, 'PATCH', `/roles/assignments/${assignment.id}/end`, {
      effectiveTo: '2030-06-30',
      endReason: 'resigned',
    });
    expect(ended.status).toBe(200);

    // The row is still there — history is never deleted — but it no longer occupies a seat.
    expect(await occupancyOf(role.id)).toMatchObject({ filled: 0, vacancies: 2 });
    const history = await historyOf(FIXTURE.NO_PERMISSIONS.id);
    expect(history.find((a) => a.id === assignment.id)).toMatchObject({
      effectiveTo: '2030-06-30',
      endReason: 'resigned',
    });
  });

  it('narrows to roles with a free seat with vacantOnly', async () => {
    const full = await createRole(1);
    const open = await createRole(1);
    expect((await assign(full.id, FIXTURE.NO_PERMISSIONS.id, '2031-01-01')).status).toBe(201);

    const { status, body } = await apiRequest(
      app,
      hr,
      'GET',
      `/roles?department=${DEPARTMENT}&vacantOnly=true&limit=100`,
    );
    expect(status).toBe(200);
    const ids = unwrap<RoleRow[]>(body).map((p) => p.id);
    expect(ids).toContain(open.id);
    expect(ids).not.toContain(full.id);
  });

  it('finds a role by search over its code, title and department', async () => {
    // The SPA shipped a search box for this list before the API had the parameter, so the box looked
    // like it filtered and the term was dropped. Asserting on all three fields because the point of a
    // free-text search is that somebody types whichever one they remember.
    const target = await createRole(2);

    for (const term of [target.code, 'E2E Engineer', DEPARTMENT]) {
      const { status, body } = await apiRequest(
        app,
        hr,
        'GET',
        `/roles?search=${encodeURIComponent(term)}&limit=100`,
      );
      expect(status, `search=${term}`).toBe(200);
      expect(
        unwrap<RoleRow[]>(body).map((p) => p.id),
        `search=${term} did not find the role`,
      ).toContain(target.id);
    }

    // And it NARROWS: a term that matches nothing returns nothing, rather than the whole list — which
    // is what a silently-dropped parameter looks like.
    const { body: noMatch } = await apiRequest(
      app,
      hr,
      'GET',
      `/roles?search=NOSUCHROLE-${RUN}&limit=100`,
    );
    expect(unwrap<RoleRow[]>(noMatch)).toHaveLength(0);
  });
});

describe('approved headcount', () => {
  it('refuses the assignment that would exceed it, and allows it once raised', async () => {
    const role = await createRole(1);
    expect((await assign(role.id, FIXTURE.NO_PERMISSIONS.id, '2032-01-01')).status).toBe(201);

    const refused = await assign(role.id, FIXTURE.MANAGER.id, '2032-01-01');
    expect(refused.status).toBe(412);
    expect(errorCode(refused.body)).toBe('ROLE_HEADCOUNT_EXCEEDED');

    const raised = await apiRequest(app, hr, 'PATCH', `/roles/${role.id}`, {
      headcount: 2,
    });
    expect(raised.status).toBe(200);

    expect((await assign(role.id, FIXTURE.MANAGER.id, '2032-01-01')).status).toBe(201);
    expect(await occupancyOf(role.id)).toMatchObject({ filled: 2, vacancies: 0 });
  });

  it('allows a reduction below current occupancy, then blocks the next assignment', async () => {
    // Deliberate: a restructure is a real event and must be recordable without moving people out
    // first. The constraint belongs on the next assignment.
    const role = await createRole(2);
    expect((await assign(role.id, FIXTURE.NO_PERMISSIONS.id, '2033-01-01')).status).toBe(201);
    expect((await assign(role.id, FIXTURE.MANAGER.id, '2033-01-01')).status).toBe(201);

    const cut = await apiRequest(app, hr, 'PATCH', `/roles/${role.id}`, { headcount: 1 });
    expect(cut.status).toBe(200);

    // Over-occupied, reported as zero vacancies rather than a negative number.
    expect(await occupancyOf(role.id)).toMatchObject({
      headcount: 1,
      filled: 2,
      vacancies: 0,
    });

    const refused = await assign(role.id, FIXTURE.ADMIN.id, '2033-02-01');
    expect(refused.status).toBe(412);
    expect(errorCode(refused.body)).toBe('ROLE_HEADCOUNT_EXCEEDED');
  });
});

describe('transfer', () => {
  it('closes the outgoing assignment and opens the incoming one as one act', async () => {
    const from = await createRole(1);
    const to = await createRole(1);

    const first = unwrap<AssignmentRow>(
      (await assign(from.id, FIXTURE.NO_PERMISSIONS.id, '2034-01-01')).body,
    );
    const second = await assign(to.id, FIXTURE.NO_PERMISSIONS.id, '2034-07-01');
    expect(second.status).toBe(201);

    const history = await historyOf(FIXTURE.NO_PERMISSIONS.id);
    // The old row is closed on the day the new one starts, with a reason, and the new one is open.
    expect(history.find((a) => a.id === first.id)).toMatchObject({
      effectiveTo: '2034-07-01',
      endReason: 'transfer',
    });
    expect(history.find((a) => a.id === unwrap<AssignmentRow>(second.body).id)).toMatchObject({
      effectiveTo: null,
    });
    // The invariant `uq_employee_current_role` exists to hold: exactly one open row.
    expect(history.filter((a) => a.effectiveTo === null)).toHaveLength(1);

    // And the seat they left is free again.
    expect(await occupancyOf(from.id)).toMatchObject({ filled: 0, vacancies: 1 });
  });

  it('allows a transfer into a role that their own outgoing assignment fills', async () => {
    // The count is taken AFTER the outgoing row closes, so moving between two 1-seat roles is
    // not blocked by the mover themselves.
    const from = await createRole(1);
    const to = await createRole(1);
    expect((await assign(from.id, FIXTURE.MANAGER.id, '2035-01-01')).status).toBe(201);
    expect((await assign(to.id, FIXTURE.MANAGER.id, '2035-02-01')).status).toBe(201);
    expect(await occupancyOf(to.id)).toMatchObject({ filled: 1, vacancies: 0 });
  });

  it('refuses re-assigning someone to the role they already hold', async () => {
    const role = await createRole(2);
    const first = unwrap<AssignmentRow>(
      (await assign(role.id, FIXTURE.NO_PERMISSIONS.id, '2036-01-01')).body,
    );

    const again = await assign(role.id, FIXTURE.NO_PERMISSIONS.id, '2036-06-01');
    expect(again.status).toBe(409);

    // The original row is untouched — a close-and-reopen would have rewritten its start date and
    // lost when the person actually took the job.
    const history = await historyOf(FIXTURE.NO_PERMISSIONS.id);
    expect(history.find((a) => a.id === first.id)).toMatchObject({
      effectiveFrom: '2036-01-01',
      effectiveTo: null,
    });
  });

  it('refuses a transfer dated before the current assignment began', async () => {
    const from = await createRole(1);
    const to = await createRole(1);
    expect((await assign(from.id, FIXTURE.NO_PERMISSIONS.id, '2037-06-01')).status).toBe(201);

    const backdated = await assign(to.id, FIXTURE.NO_PERMISSIONS.id, '2037-01-01');
    // Without the service guard this reached `ck_employee_role_window` and the caller got a
    // 500 with no indication of what was wrong. Probed live before this test existed.
    expect(backdated.status).toBe(412);
    expect(errorCode(backdated.body)).toBe('ROLE_INVALID_WINDOW');

    // Nothing half-happened: they still hold the role they started in.
    const open = (await historyOf(FIXTURE.NO_PERMISSIONS.id)).filter((a) => a.effectiveTo === null);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ roleId: from.id, effectiveFrom: '2037-06-01' });
  });
});

describe('ending an assignment', () => {
  it('refuses an end date before it began, and refuses to close it twice', async () => {
    const role = await createRole(1);
    const assignment = unwrap<AssignmentRow>(
      (await assign(role.id, FIXTURE.NO_PERMISSIONS.id, '2038-06-01')).body,
    );

    const early = await apiRequest(app, hr, 'PATCH', `/roles/assignments/${assignment.id}/end`, {
      effectiveTo: '2038-01-01',
    });
    expect(early.status).toBe(412);
    expect(errorCode(early.body)).toBe('ROLE_INVALID_WINDOW');

    const ok = await apiRequest(app, hr, 'PATCH', `/roles/assignments/${assignment.id}/end`, {
      effectiveTo: '2038-09-01',
    });
    expect(ok.status).toBe(200);

    // Closing a closed assignment would otherwise silently rewrite its end date, which is why the
    // repository's WHERE clause is open-only rather than a read-then-write check.
    const twice = await apiRequest(app, hr, 'PATCH', `/roles/assignments/${assignment.id}/end`, {
      effectiveTo: '2038-12-01',
    });
    expect(twice.status).toBe(404);
    const row = (await historyOf(FIXTURE.NO_PERMISSIONS.id)).find((a) => a.id === assignment.id);
    expect(row).toMatchObject({ effectiveTo: '2038-09-01' });
  });
});

describe('a frozen role', () => {
  it('keeps its occupants but accepts nobody new', async () => {
    const role = await createRole(2);
    expect((await assign(role.id, FIXTURE.NO_PERMISSIONS.id, '2039-01-01')).status).toBe(201);

    const frozen = await apiRequest(app, hr, 'PATCH', `/roles/${role.id}`, {
      status: 'frozen',
    });
    expect(frozen.status).toBe(200);

    const refused = await assign(role.id, FIXTURE.MANAGER.id, '2039-02-01');
    expect(refused.status).toBe(412);

    // The occupant is still counted: a hiring pause is not a dismissal.
    expect(await occupancyOf(role.id)).toMatchObject({ filled: 1 });
  });
});

describe('naming who holds the role', () => {
  /*
   * `GET /roles/:id/assignments` is opened to answer "who has held this role", and the SPA
   * rendered `employeeId` — so the table answered with uuids.
   *
   * The WRITES keep the plain shape on purpose, and that asymmetry is asserted below: `assign` hands
   * the row back to a caller who just supplied the employee id, so resolving it would tell them what
   * they passed in. A field that appears on every shape "for consistency" is a query nobody needed.
   */
  it('names the employee on a role READ, and not on the write that created it', async () => {
    const role = await createRole(1);
    const created = await assign(role.id, FIXTURE.NO_PERMISSIONS.id, '2041-01-01');
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(
      (unwrap<AssignmentRow>(created.body) as { employeeName?: unknown }).employeeName,
      'the write resolved a name its caller already had',
    ).toBeUndefined();

    const { status, body } = await apiRequest(app, hr, 'GET', `/roles/${role.id}/assignments`);
    expect(status, JSON.stringify(body)).toBe(200);
    const rows = unwrap<AssignmentRow[]>(body);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.employeeName, `assignment ${row.id} came back with no employee name`).toBeTruthy();
    }
  });
});

describe('authorization', () => {
  it('lets a role.read holder read but not manage', async () => {
    const role = await createRole(1);

    expect((await apiRequest(app, manager, 'GET', `/roles/${role.id}`)).status).toBe(200);
    expect((await apiRequest(app, manager, 'GET', `/roles/${role.id}/assignments`)).status).toBe(
      200,
    );

    // `role.manage` is separate from `role.read` because approving a headcount or moving
    // somebody between roles changes the org structure, which reading it does not.
    const create = await apiRequest(app, manager, 'POST', '/roles', {
      code: nextCode(),
      title: 'Nope',
      department: DEPARTMENT,
    });
    expect(create.status).toBe(403);
    expect(
      (await apiRequest(app, manager, 'PATCH', `/roles/${role.id}`, { headcount: 5 })).status,
    ).toBe(403);
    expect(
      (
        await apiRequest(app, manager, 'POST', `/roles/${role.id}/assignments`, {
          employeeId: FIXTURE.MANAGER.id,
          effectiveFrom: '2040-01-01',
        })
      ).status,
    ).toBe(403);
  });

  it('refuses the catalogue to a caller holding no permissions', async () => {
    expect((await apiRequest(app, employee, 'GET', '/roles')).status).toBe(403);
    expect(
      (await apiRequest(app, employee, 'GET', `/roles/employees/${FIXTURE.MANAGER.id}/history`))
        .status,
    ).toBe(403);
  });

  it('lets any employee read their OWN role history', async () => {
    // Self-scoped: knowing your own role and when it changed is not privileged information about
    // anyone else, so it needs no permission code.
    const { status, body } = await apiRequest(app, employee, 'GET', '/roles/me');
    expect(status).toBe(200);
    const mine = unwrap<AssignmentRow[]>(body);
    expect(mine.every((a) => a.employeeId === FIXTURE.NO_PERMISSIONS.id)).toBe(true);
  });
});

describe('unknown ids', () => {
  it('404s rather than returning an empty history', async () => {
    const missing = '00000000-0000-7000-8000-0000000000ff';
    // An empty array would read as "nobody has ever held it", which is a different fact.
    expect((await apiRequest(app, hr, 'GET', `/roles/${missing}`)).status).toBe(404);
    expect((await apiRequest(app, hr, 'GET', `/roles/${missing}/assignments`)).status).toBe(404);
    expect((await apiRequest(app, hr, 'GET', `/roles/employees/${missing}/history`)).status).toBe(
      404,
    );
  });

  it('refuses an assignment for an employee who does not exist', async () => {
    // `employee_id` carries no cross-schema FK, matching every other module, so without the
    // service's own check a typo would become an assignment for nobody.
    const role = await createRole(1);
    const { status } = await assign(role.id, '00000000-0000-7000-8000-0000000000fe', '2041-01-01');
    expect(status).toBe(404);
  });
});
describe('my own history', () => {
  /**
   * `/roles/me` IS SELF-SCOPED, AND HAS TO BE READABLE ON ITS OWN TERMS.
   *
   * Anybody may read their own assignment history — no permission code. But every route that could turn a
   * `roleId` into a title needs `role.read`, which `FIXTURE.NO_PERMISSIONS` does not hold. So the
   * self-service answer used to be a list of UUIDs the caller had no way to resolve, and the only honest
   * thing a screen could render was the id itself.
   *
   * The join is the fix, and this is the test that pins it: read as the employee, with no permissions at
   * all, and the role has to come back named.
   */
  it('names the role, for a caller who holds no permission to look one up', async () => {
    const role = await createRole(2);
    /*
     * LATER THAN EVERY OTHER DATE IN THIS FILE. Assigning somebody who already holds a role is a
     * TRANSFER, and a transfer cannot start before the assignment it closes began — the suite's other tests
     * leave these principals holding roles dated into 2041, so an earlier date answers
     * `ROLE_INVALID_WINDOW`. Learned by asserting 201 and reading the refusal.
     */
    const assigned = await assign(role.id, FIXTURE.NO_PERMISSIONS.id, '2045-01-01');
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(201);

    const mine = unwrap<AssignmentRow[]>(
      (await apiRequest(app, employee, 'GET', '/roles/me')).body,
    );
    const row = mine.find((r) => r.roleId === role.id);
    expect(row, 'the assignment is missing from the caller own history').toBeTruthy();

    // The two fields that make the row readable without `role.read`.
    expect(row!.roleCode).toBe(role.code);
    expect(row!.roleTitle).toBe(role.title);

    // AND THE CALLER STILL CANNOT LOOK ONE UP DIRECTLY. If they could, the join would be a convenience
    // rather than the only route to the title — and this test would be pinning nothing.
    expect((await apiRequest(app, employee, 'GET', `/roles/${role.id}`)).status).toBe(403);
  });

  it('names the role on somebody else history too, since it is the same query', async () => {
    const role = await createRole(1);
    const assigned = await assign(role.id, FIXTURE.MANAGER.id, '2045-02-01');
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(201);

    const rows = await historyOf(FIXTURE.MANAGER.id);
    const row = rows.find((r) => r.roleId === role.id);
    expect(row!.roleTitle).toBe(role.title);
  });
});
