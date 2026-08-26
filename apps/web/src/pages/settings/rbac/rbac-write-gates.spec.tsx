// @vitest-environment jsdom
/**
 * WHO MAY WRITE ON THE ACCESS CONTROL SCREEN — asserted, because no browser test can ask.
 *
 * WHY THIS FILE EXISTS. The screen is reached with `rbac.read` (the nav gates `/settings/access-control`
 * on exactly that) and its five write controls were reached with nothing at all. `it-admin` and
 * `auditor` hold `rbac.read`; only `admin` holds `rbac.manage` and `role.assign`. So two of the eight
 * seeded roles were shown New role, Delete role, Add permission, Remove permission, Assign role and
 * Revoke, and the API answered 403 to every one of them — a screenful of affordances that could not do
 * anything, on the screen whose entire subject is who may do what.
 *
 * THE REASON IT SURVIVED REVIEW IS A NAME. `use-rbac.ts` exported `usePermissions()`, which returns the
 * permission CATALOGUE, while `@/shared/hooks/use-permissions` exports a `usePermissions()` that returns
 * what the CALLER holds. `roles-tab.tsx` imported the first, so the file read as though it consulted the
 * caller's permissions. It is `usePermissionCatalogue()` now, and this file is the assertion that the
 * real hook is the one being consulted.
 *
 * AND WHY IT IS A COMPONENT SPEC. All eight Playwright seats are admins, so an `rbac.read`-only caller
 * is a tier the browser suite cannot represent — every seat sees every control and every seat may use
 * it. `can` is therefore mocked here per test, which is the only way to put a reader in front of this
 * screen at all.
 *
 * THE GATES ARE TWO DIFFERENT PERMISSIONS, not one, and the cross-checks below are the point: role
 * MANAGEMENT is `rbac.manage` and role ASSIGNMENT is `role.assign`, read off
 * `libs/modules/authz/src/interface/http/authz.controller.ts`. Gating both on one flag would pass every
 * "a reader sees nothing" assertion while handing each holder the other's controls.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The caller's permissions, mutable per test.
 *
 * `vi.hoisted` because `vi.mock` factories are lifted above every declaration in the file: a plain
 * `const` read inside the factory is in its temporal dead zone when the mocked module is first
 * imported. This is the shape that survives that lift.
 */
const caller = vi.hoisted(() => ({ permissions: [] as string[] }));

const GET = vi.fn();
const POST = vi.fn();
const PUT = vi.fn();
const DELETE = vi.fn();

vi.mock('@/shared/api/client', () => ({
  api: {
    GET: (...a: unknown[]) => GET(...a),
    POST: (...a: unknown[]) => POST(...a),
    PUT: (...a: unknown[]) => PUT(...a),
    DELETE: (...a: unknown[]) => DELETE(...a),
  },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/shared/hooks/use-permissions', () => ({
  usePermissions: () => ({ can: (perm: string) => caller.permissions.includes(perm) }),
}));
// The drawer's activity section fetches audit entries. What is under test is which CONTROLS the drawer
// offers, so the timeline is stubbed rather than fed a fixture that would only add noise.
vi.mock('@/shared/ui/activity-timeline', () => ({ ActivityTimeline: () => <div /> }));

import { AssignmentsTab } from './assignments-tab';
import { DelegationsTab } from './delegations-tab';
import { RolesTab } from './roles-tab';

const CUSTOM_ROLE = {
  id: 'role-1',
  key: 'compliance-reviewer',
  name: 'Compliance Reviewer',
  system: false,
  permissions: ['audit.read'],
  updatedAt: '2026-08-01T09:00:00.000Z',
};

const SYSTEM_ROLE = {
  id: 'role-2',
  key: 'admin',
  name: 'Platform Administrator',
  system: true,
  permissions: ['*'],
  updatedAt: '2026-08-01T09:00:00.000Z',
};

const CATALOGUE = [
  { key: 'audit.read', description: 'Read the audit log' },
  { key: 'asset.read', description: 'Read assets' },
];

const ASSIGNMENT = {
  id: 'ra-1',
  userId: '019fff6b-855d-7fac-8f5e-f79f4fec0bc3',
  roleId: 'role-1',
  scopeType: 'global',
  scopeId: null,
  grantedBy: 'admin',
  expiresAt: null,
  createdAt: '2026-08-01T09:00:00.000Z',
};

const DELEGATION = {
  id: 'd-1',
  fromUserId: 'me',
  toUserId: 'them',
  startsAt: '2026-08-01T09:00:00.000Z',
  endsAt: '2026-09-01T09:00:00.000Z',
  reason: 'Parental leave coverage',
  createdAt: '2026-08-01T09:00:00.000Z',
};

const EMPLOYEE = {
  id: '019fff6b-855d-7fac-8f5e-f79f4fec0bc3',
  displayName: 'Alice Nguyen',
  department: 'Compliance',
  email: 'alice@example.com',
};

/** Routed by path, because these tabs read four endpoints and each needs its own shape. */
function routeReads() {
  GET.mockImplementation((path: string) => {
    if (path === '/v1/authz/roles') return Promise.resolve({ data: [CUSTOM_ROLE, SYSTEM_ROLE] });
    if (path === '/v1/authz/permissions') return Promise.resolve({ data: CATALOGUE });
    if (path === '/v1/authz/users/{userId}/assignments')
      return Promise.resolve({ data: [ASSIGNMENT] });
    if (path === '/v1/authz/delegations') return Promise.resolve({ data: [DELEGATION] });
    if (path === '/v1/employees') return Promise.resolve({ data: { data: [EMPLOYEE] } });
    return Promise.resolve({ data: [] });
  });
}

function renderIn(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

/** Open the custom role's drawer, which is where three of the five controls live. */
async function openCustomRoleDrawer() {
  const row = await screen.findByText('Compliance Reviewer');
  fireEvent.click(row.closest('tr') as HTMLElement);
  // The chip proves the drawer is OPEN. Without this the "no remove control" assertions below would
  // also pass on a drawer that never rendered, which is the failure mode of asserting absence.
  expect(await screen.findByText('audit.read')).toBeTruthy();
}

/** Look a user up, which is the only way this tab renders a row to revoke. */
async function lookUpAssignments() {
  fireEvent.change(screen.getByLabelText('User ID to look up'), {
    target: { value: ASSIGNMENT.userId },
  });
  fireEvent.click(screen.getByRole('button', { name: /look up/i }));
  expect(await screen.findByText('Compliance Reviewer')).toBeTruthy();
}

beforeEach(() => {
  vi.clearAllMocks();
  routeReads();
  caller.permissions = [];
});

describe('the Roles tab, for an rbac.read holder', () => {
  beforeEach(() => {
    caller.permissions = ['rbac.read'];
  });

  it('shows the roles, because reading them is what the permission is for', async () => {
    renderIn(<RolesTab />);
    // The floor for everything below: an auditor is MEANT to be here. Hiding the screen would be the
    // wrong fix, and an assertion that only counts absences would be satisfied by a blank page.
    expect(await screen.findByText('Compliance Reviewer')).toBeTruthy();
    expect(screen.getByText('Platform Administrator')).toBeTruthy();
  });

  it('offers no New role and no delete, because both routes need rbac.manage', async () => {
    renderIn(<RolesTab />);
    await screen.findByText('Compliance Reviewer');

    // `POST /authz/roles` and `DELETE /authz/roles/:id` are `@RequirePermission('rbac.manage')`. Both
    // controls answered 403 for this caller, and the delete one asked for a confirmation first.
    expect(screen.queryByRole('button', { name: /new role/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete Compliance Reviewer' })).toBeNull();
  });

  it('shows a role’s permissions without offering to change them', async () => {
    renderIn(<RolesTab />);
    await openCustomRoleDrawer();

    /*
     * Both controls in the drawer are the same route — `PUT /authz/roles/:id/permissions` replaces the
     * whole set — so removing a permission is as privileged as granting one. The X on a chip is the
     * easier one to leave behind, because it does not look like a form.
     */
    expect(screen.queryByRole('button', { name: 'Remove audit.read' })).toBeNull();
    expect(screen.queryByLabelText('Permission to add')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
  });
});

describe('the Roles tab, for an rbac.manage holder', () => {
  beforeEach(() => {
    caller.permissions = ['rbac.read', 'rbac.manage'];
  });

  it('offers New role and the delete the API would accept', async () => {
    renderIn(<RolesTab />);
    await screen.findByText('Compliance Reviewer');

    // THE OTHER HALF. Every assertion in the read-only block above is an absence, and a gate written
    // as `false` would satisfy all of them while breaking the screen for the one role that runs it.
    expect(screen.getByRole('button', { name: /new role/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete Compliance Reviewer' })).toBeTruthy();
  });

  it('still refuses to delete a system role, because the seed owns it', async () => {
    renderIn(<RolesTab />);
    await screen.findByText('Platform Administrator');
    /*
     * The permission gate is ANDed with the pre-existing `!role.system` rule, and the order matters:
     * a gate written as `canManage || !role.system` reads almost identically and would put a delete
     * control on the role the guards depend on.
     */
    expect(screen.queryByRole('button', { name: 'Delete Platform Administrator' })).toBeNull();
  });

  it('offers both permission controls in the drawer', async () => {
    renderIn(<RolesTab />);
    await openCustomRoleDrawer();

    expect(screen.getByRole('button', { name: 'Remove audit.read' })).toBeTruthy();
    // The catalogue drives this select — `usePermissionCatalogue()`, the hook whose old name was the
    // reason none of these gates existed. Its options are the permissions the role does NOT hold.
    expect(screen.getByLabelText('Permission to add')).toBeTruthy();
    expect(screen.getByRole('option', { name: 'asset.read' })).toBeTruthy();
  });
});

describe('the Roles tab, for a role.assign holder', () => {
  it('does not treat handing roles out as permission to rewrite them', async () => {
    /*
     * THE CROSS-CHECK. `role.assign` and `rbac.manage` are separate permissions on separate routes, so
     * the holder of one must not inherit the other's controls. Gating this whole screen on a single
     * "may administer access" flag would pass every other test in this file.
     */
    caller.permissions = ['rbac.read', 'role.assign'];
    renderIn(<RolesTab />);
    await screen.findByText('Compliance Reviewer');

    expect(screen.queryByRole('button', { name: /new role/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete Compliance Reviewer' })).toBeNull();
  });
});

describe('the Assignments tab, for an rbac.read holder', () => {
  beforeEach(() => {
    caller.permissions = ['rbac.read'];
  });

  it('still looks a user up, because reading who holds what is the auditor’s job', async () => {
    renderIn(<AssignmentsTab />);
    await lookUpAssignments();
    // `GET /authz/users/:userId/assignments` is `rbac.read`. Gating the lookup as well would have been
    // the over-correction: it is the only thing on this tab a reader is here to do.
    expect(screen.getByText(ASSIGNMENT.userId)).toBeTruthy();
  });

  it('offers neither Assign role nor Revoke, because both need role.assign', async () => {
    renderIn(<AssignmentsTab />);
    await lookUpAssignments();

    expect(screen.queryByRole('button', { name: /assign role/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Revoke assignment' })).toBeNull();
  });
});

describe('the Assignments tab, for a role.assign holder', () => {
  beforeEach(() => {
    caller.permissions = ['rbac.read', 'role.assign'];
  });

  it('offers Assign role and a Revoke on the row', async () => {
    renderIn(<AssignmentsTab />);
    await lookUpAssignments();

    expect(screen.getByRole('button', { name: /assign role/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Revoke assignment' })).toBeTruthy();
  });

  it('does not treat rewriting roles as permission to hand them out', async () => {
    // The mirror of the Roles tab cross-check, in the other direction.
    caller.permissions = ['rbac.read', 'rbac.manage'];
    renderIn(<AssignmentsTab />);
    await lookUpAssignments();

    expect(screen.queryByRole('button', { name: /assign role/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Revoke assignment' })).toBeNull();
  });

  it('reports a refused assignment in the API’s words, not by blaming the id', async () => {
    /*
     * WHAT THIS REPLACED. The form said "Failed to assign role. Check the user ID." for every failure.
     * The id comes out of a picker, so it is the one part of the submission nobody mistyped — and the
     * likeliest refusal was a missing permission. That sentence sent people looking for a typo in a
     * value the picker supplied, which is worse than saying nothing.
     *
     * The gate above hides the button from a caller who plainly lacks `role.assign`, but the message
     * still has to carry the API's reason: a stale token, a role deleted underneath the open form, or a
     * scope the caller may not write all arrive here and all say something different.
     */
    POST.mockResolvedValue({
      error: { error: { code: 'FORBIDDEN', message: 'Missing required permission: role.assign' } },
    });

    renderIn(<AssignmentsTab />);
    fireEvent.click(await screen.findByRole('button', { name: /assign role/i }));

    // Chosen through the picker, deliberately: it is the picker that makes "check the user ID" absurd.
    /*
     * Scoped to the dialog, and matched loosely. `FormField` appends a required marker to the label
     * text, so the accessible name is "User *" rather than "User" — and the tab behind the dialog has
     * its own "User ID to look up" field, which a `/^User/` search over the whole document also finds.
     */
    const dialog = within(screen.getByRole('dialog'));
    fireEvent.focus(dialog.getByLabelText(/^User/));
    fireEvent.mouseDown(await dialog.findByRole('button', { name: /Alice Nguyen/ }));
    fireEvent.change(dialog.getByLabelText(/^Role/), { target: { value: CUSTOM_ROLE.id } });
    fireEvent.click(dialog.getByRole('button', { name: 'Assign' }));

    expect(await screen.findByText('Missing required permission: role.assign')).toBeTruthy();
    expect(screen.queryByText(/check the user id/i)).toBeNull();
    await waitFor(() => expect(POST).toHaveBeenCalledTimes(1));
  });
});

describe('the Delegations tab, for an rbac.read holder', () => {
  it('keeps its write controls, because the API asks for no permission at all', async () => {
    /*
     * THE ONE THAT MUST NOT BE GATED, and the reason it is asserted rather than left implicit.
     *
     * The three delegation routes carry `@SelfScoped`, not `@RequirePermission`: the grantor is taken
     * from the token (`fromUserId is user.sub`), the body cannot name anybody else, revoke is keyed on
     * `(id, user.sub)`, and the list defaults to the caller's own. So every authenticated person may
     * hand their own approval authority over for a fortnight, and hiding this behind `rbac.manage`
     * would take out-of-office cover away from the whole organisation to prevent a 403 the API would
     * never raise.
     *
     * A later sweep for "ungated write controls on the RBAC screen" is exactly the change this stops.
     */
    caller.permissions = ['rbac.read'];
    renderIn(<DelegationsTab />);

    expect(await screen.findByText('Parental leave coverage')).toBeTruthy();
    expect(screen.getByRole('button', { name: /new delegation/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete delegation' })).toBeTruthy();
  });
});
