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
  const authz = {
    invalidate: vi.fn().mockResolvedValue(undefined),
    resolve: vi.fn(),
  } as unknown as AuthzService & { invalidate: ReturnType<typeof vi.fn> };
  const audit = createFakeAudit();
  /** The transaction each mutation and its audit entry now share. */
  const TX = { tx: true };
  const db = { transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(TX)) };

  const service = new AuthzAdminService(
    roleRepo,
    assignmentRepo,
    authz,
    db as never,
    audit as never,
  );

  return { service, roleRepo, assignmentRepo, authz, holders, audit, TX };
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
    const { service, authz, holders } = build();

    await service.setRolePermissions('role-1', ['asset.read'], actor);

    for (const userId of holders) {
      expect(authz.invalidate).toHaveBeenCalledWith(userId);
    }
    expect(authz.invalidate).toHaveBeenCalledTimes(holders.length);
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
    const { service, authz, assignmentRepo, holders } = build();

    await service.deleteRole('role-1', actor);

    for (const userId of holders) {
      expect(authz.invalidate).toHaveBeenCalledWith(userId);
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
    const { service, roleRepo, authz } = build({ system: true });

    await expect(service.deleteRole('role-1', actor)).rejects.toMatchObject({
      code: 'ROLE_IMMUTABLE',
    });
    expect(roleRepo.delete).not.toHaveBeenCalled();
    expect(authz.invalidate).not.toHaveBeenCalled();
  });

  it('is a no-op on caches when a role has no holders', async () => {
    const { service, authz } = build({ holders: [] });

    await service.setRolePermissions('role-1', ['asset.read'], actor);

    expect(authz.invalidate).not.toHaveBeenCalled();
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
