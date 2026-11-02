import { describe, expect, it, vi } from 'vitest';
import type { AuthzService } from '@platform';
import { AuthzAdminService } from './authz-admin.service';
import { createFakeAudit } from '../../../audit/src/testing/audit.fake';

/**
 * Cache invalidation on role-DEFINITION changes.
 *
 * Every write path in this service invalidates the holder's cached permission
 * resolution — except two, which used to rely on the 300s cache TTL instead:
 * `setRolePermissions` (documented as "propagates within the cache TTL") and
 * `deleteRole` (undocumented). So removing a permission from a role, or deleting the
 * role outright, left every holder with the old grants for up to five minutes, while
 * assigning and revoking took effect immediately.
 *
 * Two revocation latencies in one service is the defect, and the slow one is the
 * security-relevant direction. These tests pin the fast one.
 */

const actor = { sub: 'admin-1', email: 'admin@example.test' };

function build(overrides: { holders?: string[]; system?: boolean } = {}) {
  const holders = overrides.holders ?? ['user-a', 'user-b'];

  const role = {
    id: 'role-1',
    key: 'helpdesk',
    name: 'Help Desk',
    system: overrides.system ?? false,
    updatedAt: new Date(),
    permissions: ['asset.read', 'asset.write'],
  };

  const roleRepo = {
    findById: vi.fn().mockResolvedValue(role),
    findByKey: vi.fn().mockResolvedValue(role),
    setPermissions: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([role]),
    create: vi.fn(),
    // The service validates incoming codes against the catalogue table.
    listPermissions: vi.fn().mockResolvedValue([{ key: 'asset.read' }, { key: 'asset.write' }]),
  };

  const assignmentRepo = {
    listUserIdsForRole: vi.fn().mockResolvedValue(holders),
    syncEmployeeRoleClaims: vi.fn().mockResolvedValue([]),
    listForUser: vi.fn().mockResolvedValue([]),
    findById: vi.fn(),
    assign: vi.fn(),
    revoke: vi.fn(),
  };

  // Assert at the DECLARATION, not at each call site: these are partial doubles, so
  // the cast belongs where the shape is narrowed, and the constructor call below
  // stays free of noise.
  const invalidate = vi.fn().mockResolvedValue(undefined);
  const resolve = vi.fn();
  const authz = { invalidate, resolve } as unknown as AuthzService & {
    invalidate: ReturnType<typeof vi.fn>;
    resolve: ReturnType<typeof vi.fn>;
  };
  const audit = createFakeAudit();
  /** The transaction each mutation and its audit entry now share. */
  const TX = { tx: true };
  /** `select … from employees where id = … limit 1` resolves to the employee the grant targets. */
  const employeeLookup = vi.fn().mockResolvedValue([{ id: 'emp-1' }]);
  const db = {
    transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(TX)),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: employeeLookup }),
      }),
    }),
  };

  const employeePermissionRepo = {
    listForEmployee: vi.fn().mockResolvedValue([]),
    findById: vi.fn(),
    grant: vi.fn(),
    revoke: vi.fn().mockResolvedValue(undefined),
  };

  const service = new AuthzAdminService(
    roleRepo,
    assignmentRepo,
    employeePermissionRepo,
    authz,
    db as never,
    audit as never,
  );

  return {
    service,
    roleRepo,
    assignmentRepo,
    employeePermissionRepo,
    authz,
    invalidate,
    holders,
    audit,
    TX,
    employeeLookup,
  };
}

describe('AuthzAdminService — the audit entry rides the mutation', () => {
  /*
   * WHY THIS IS ASSERTED HERE OF ALL PLACES. "Who granted which role to whom" is the first question an
   * access review asks, and these writes were fire-and-forget: the grant could commit while the entry was
   * lost, leaving the review with no answer. The `tx` in the assertion IS the guarantee.
   */
  it('records a permission change inside the transaction that made it', async () => {
    const { service, audit, TX } = build();

    await service.setRolePermissions('role-1', ['asset.read'], actor);

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'role.permissions_updated' }),
      TX,
    );
  });

  it('records a revocation inside its transaction', async () => {
    const { service, assignmentRepo, audit, TX } = build();
    assignmentRepo.findById.mockResolvedValue({
      id: 'assign-1',
      userId: 'user-9',
      roleId: 'role-1',
      scopeType: 'global',
      scopeId: null,
    });

    await service.revokeAssignment('assign-1', actor);

    expect(assignmentRepo.revoke).toHaveBeenCalledWith('assign-1', TX);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'role.revoked' }),
      TX,
    );
  });
});

describe('AuthzAdminService — role-definition changes', () => {
  it('invalidates every holder when a role’s permissions change', async () => {
    const { service, invalidate, holders } = build();

    await service.setRolePermissions('role-1', ['asset.read'], actor);

    for (const userId of holders) {
      expect(invalidate).toHaveBeenCalledWith(userId);
    }
    expect(invalidate).toHaveBeenCalledTimes(holders.length);
  });

  it('does not re-sync role claims when only permissions change', async () => {
    // `employees.roles` holds role KEYS, which this operation does not touch.
    // Re-syncing would be a pointless write on every holder.
    const { service, assignmentRepo } = build();

    await service.setRolePermissions('role-1', ['asset.read'], actor);

    expect(assignmentRepo.syncEmployeeRoleClaims).not.toHaveBeenCalled();
  });

  it('invalidates AND re-syncs claims when a role is deleted', async () => {
    // Deleting a role makes both caches wrong: the permission cache still grants its
    // codes, and `employees.roles` still lists its key.
    const { service, invalidate, assignmentRepo, holders } = build();

    await service.deleteRole('role-1', actor);

    for (const userId of holders) {
      expect(invalidate).toHaveBeenCalledWith(userId);
      expect(assignmentRepo.syncEmployeeRoleClaims).toHaveBeenCalledWith(userId);
    }
  });

  it('reads the holders BEFORE deleting the role', async () => {
    // `user_role_assignments.role_id` is ON DELETE CASCADE, so enumerating holders
    // after the delete returns nobody and silently invalidates nothing.
    const calls: string[] = [];
    const { service, roleRepo, assignmentRepo } = build();
    assignmentRepo.listUserIdsForRole.mockImplementation(() => {
      calls.push('list');
      return Promise.resolve(['user-a']);
    });
    roleRepo.delete.mockImplementation(() => {
      calls.push('delete');
      return Promise.resolve();
    });

    await service.deleteRole('role-1', actor);

    expect(calls).toEqual(['list', 'delete']);
  });

  it('refuses to delete a system role, and touches no cache', async () => {
    const { service, roleRepo, invalidate } = build({ system: true });

    await expect(service.deleteRole('role-1', actor)).rejects.toMatchObject({
      code: 'ROLE_IMMUTABLE',
    });
    expect(roleRepo.delete).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('is a no-op on caches when a role has no holders', async () => {
    const { service, invalidate } = build({ holders: [] });

    await service.setRolePermissions('role-1', ['asset.read'], actor);

    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe('AuthzAdminService.syncUserRolesByKeys — the Entra App Role reconcile', () => {
  /** Roles `employee`, `hr` and `admin` exist; `current` is what the person holds globally. */
  function buildSync(current: Array<{ id: string; roleId: string }>) {
    const t = build();
    const roles = [
      { id: 'r-employee', key: 'employee' },
      { id: 'r-hr', key: 'hr' },
      { id: 'r-admin', key: 'admin' },
    ];
    t.roleRepo.list.mockResolvedValue(roles);
    t.assignmentRepo.listForUser.mockResolvedValue(
      current.map((a) => ({ ...a, scopeType: 'global' })),
    );
    t.assignmentRepo.assign.mockResolvedValue({ id: 'new' });
    t.assignmentRepo.revoke.mockResolvedValue(undefined);
    return t;
  }
  const assigned = (t: ReturnType<typeof buildSync>) =>
    t.assignmentRepo.assign.mock.calls.map((c) => (c[0] as { roleId: string }).roleId);
  const revoked = (t: ReturnType<typeof buildSync>) =>
    t.assignmentRepo.revoke.mock.calls.map((c) => c[0] as string);

  it('with no role claim and the floor, a newcomer holds `employee` and NOTHING else', async () => {
    const t = buildSync([]);

    await t.service.syncUserRolesByKeys('u', [], actor, 'employee');

    expect(assigned(t)).toEqual(['r-employee']);
  });

  it('only roles opshub has never heard of count as no claim: the floor applies, nothing unknown is granted', async () => {
    const t = buildSync([]);

    await t.service.syncUserRolesByKeys('u', ['SuperUser', 'root'], actor, 'employee');

    expect(assigned(t)).toEqual(['r-employee']);
  });

  it('the floor is NOT added to roles the token does name', async () => {
    const t = buildSync([]);

    await t.service.syncUserRolesByKeys('u', ['hr'], actor, 'employee');

    expect(assigned(t)).toEqual(['r-hr']);
  });

  it('DEMOTES at the next sign-in: an App Role removed in Entra is revoked, and the person falls to the floor', async () => {
    const t = buildSync([
      { id: 'a-admin', roleId: 'r-admin' },
      { id: 'a-hr', roleId: 'r-hr' },
    ]);

    await t.service.syncUserRolesByKeys('u', [], actor, 'employee');

    expect(revoked(t).sort()).toEqual(['a-admin', 'a-hr']);
    expect(assigned(t)).toEqual(['r-employee']);
  });

  it('without a floor, an empty claim leaves no role (the original contract is unchanged)', async () => {
    const t = buildSync([]);

    await t.service.syncUserRolesByKeys('u', [], actor);

    expect(assigned(t)).toEqual([]);
  });

  it('a missing floor role does not fail the sign-in or grant anything else', async () => {
    const t = buildSync([]);
    t.roleRepo.list.mockResolvedValue([{ id: 'r-hr', key: 'hr' }] as never);

    await t.service.syncUserRolesByKeys('u', [], actor, 'employee');

    expect(assigned(t)).toEqual([]);
  });
});

/**
 * Permissions granted straight to an employee, outside any group.
 *
 * The same three guarantees the group path has, asserted again because this is a SECOND way to hold a
 * permission and a gap here is a gap in access control: the entry rides the transaction, the grantor cannot
 * hand out more than they hold, and the employee's cached permissions are dropped so the change is immediate.
 */
describe('AuthzAdminService — direct employee permissions', () => {
  const grantCommand = {
    employeeId: 'emp-1',
    permissionKey: 'asset.read',
    reason: 'covering the help desk for a week',
  };
  const storedGrant = {
    id: 'grant-1',
    employeeId: 'emp-1',
    permissionKey: 'asset.read',
    scopeType: 'global',
    scopeId: null,
    grantedBy: 'admin-1',
    reason: grantCommand.reason,
    expiresAt: null,
    createdAt: new Date(),
  };

  it('records the grant inside its transaction and drops the employee’s cached permissions', async () => {
    const { service, authz, employeePermissionRepo, audit, TX } = build();
    authz.resolve.mockResolvedValue({
      'asset.read': [{ type: 'global', id: null }],
    });
    employeePermissionRepo.grant.mockResolvedValue(storedGrant);

    await service.grantEmployeePermission(grantCommand, actor);

    expect(employeePermissionRepo.grant).toHaveBeenCalledWith(
      expect.objectContaining({
        employeeId: 'emp-1',
        permissionKey: 'asset.read',
        scopeType: 'global',
      }),
      TX,
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'employee_permission.granted' }),
      TX,
    );
    expect(authz.invalidate).toHaveBeenCalledWith('emp-1');
  });

  it('refuses to grant a permission the grantor does not hold', async () => {
    const { service, authz, employeePermissionRepo } = build();
    authz.resolve.mockResolvedValue({
      'asset.write': [{ type: 'global', id: null }],
    });

    await expect(service.grantEmployeePermission(grantCommand, actor)).rejects.toThrow(
      /do not hold it/,
    );
    expect(employeePermissionRepo.grant).not.toHaveBeenCalled();
  });

  it('refuses a permission the grantor holds only inside a department', async () => {
    // Passing it on as global would hand the grantee more reach than the grantor has.
    const { service, authz, employeePermissionRepo } = build();
    authz.resolve.mockResolvedValue({
      'asset.read': [{ type: 'dept', id: 'QA' }],
    });

    await expect(service.grantEmployeePermission(grantCommand, actor)).rejects.toThrow();
    expect(employeePermissionRepo.grant).not.toHaveBeenCalled();
  });

  it('lets a platform administrator (the `*` wildcard) grant anything', async () => {
    const { service, authz, employeePermissionRepo } = build();
    authz.resolve.mockResolvedValue({
      '*': [{ type: 'global', id: null }],
    });
    employeePermissionRepo.grant.mockResolvedValue(storedGrant);

    await expect(service.grantEmployeePermission(grantCommand, actor)).resolves.toBe(storedGrant);
  });

  it('refuses an unknown permission key before touching the grantor’s permissions', async () => {
    const { service, authz } = build();

    await expect(
      service.grantEmployeePermission(
        { ...grantCommand, permissionKey: 'no.such.permission' },
        actor,
      ),
    ).rejects.toThrow(/Unknown permission keys/);
    expect(authz.resolve).not.toHaveBeenCalled();
  });

  it('refuses an expiry in the past', async () => {
    const { service, authz } = build();
    authz.resolve.mockResolvedValue({
      '*': [{ type: 'global', id: null }],
    });

    await expect(
      service.grantEmployeePermission(
        { ...grantCommand, expiresAt: new Date(Date.now() - 60_000) },
        actor,
      ),
    ).rejects.toThrow(/future/);
  });

  it('refuses a grant to an employee who does not exist', async () => {
    const { service, employeeLookup } = build();
    employeeLookup.mockResolvedValue([]);

    await expect(service.grantEmployeePermission(grantCommand, actor)).rejects.toThrow(/not found/);
  });

  it('records a revocation inside its transaction and drops the cached permissions', async () => {
    const { service, authz, employeePermissionRepo, audit, TX } = build();
    employeePermissionRepo.findById.mockResolvedValue(storedGrant);

    await service.revokeEmployeePermission('grant-1', actor);

    expect(employeePermissionRepo.revoke).toHaveBeenCalledWith('grant-1', TX);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'employee_permission.revoked' }),
      TX,
    );
    expect(authz.invalidate).toHaveBeenCalledWith('emp-1');
  });

  it('answers 404 when the grant to revoke does not exist', async () => {
    const { service, employeePermissionRepo } = build();
    employeePermissionRepo.findById.mockResolvedValue(null);

    await expect(service.revokeEmployeePermission('missing', actor)).rejects.toThrow(/not found/);
  });
});
