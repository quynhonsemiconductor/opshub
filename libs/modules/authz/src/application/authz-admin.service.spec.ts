import { describe, expect, it, vi } from 'vitest';
import type { AuthzService } from '@platform';
import { AuthzAdminService } from './authz-admin.service';
import { createFakeAudit } from '../../../audit/src/testing/audit.fake';

/**
 * Cache invalidation on group-DEFINITION changes.
 *
 * Every write path in this service invalidates the holder's cached permission
 * resolution — except two, which used to rely on the 300s cache TTL instead:
 * `setGroupPermissions` (documented as "propagates within the cache TTL") and
 * `deleteGroup` (undocumented). So removing a permission from a group, or deleting the
 * group outright, left every holder with the old grants for up to five minutes, while
 * assigning and revoking took effect immediately.
 *
 * Two revocation latencies in one service is the defect, and the slow one is the
 * security-relevant direction. These tests pin the fast one.
 */

const actor = { sub: 'admin-1', email: 'admin@example.test' };

function build(overrides: { holders?: string[]; system?: boolean } = {}) {
  const holders = overrides.holders ?? ['user-a', 'user-b'];

  const group = {
    id: 'group-1',
    key: 'helpdesk',
    name: 'Help Desk',
    system: overrides.system ?? false,
    updatedAt: new Date(),
    permissions: ['asset.read', 'asset.write'],
  };

  const groupRepo = {
    findById: vi.fn().mockResolvedValue(group),
    findByKey: vi.fn().mockResolvedValue(group),
    setPermissions: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([group]),
    create: vi.fn(),
    // The service validates incoming codes against the catalogue table.
    listPermissions: vi.fn().mockResolvedValue([{ key: 'asset.read' }, { key: 'asset.write' }]),
  };

  const employeeGroupRepo = {
    listEmployeeIdsForGroup: vi.fn().mockResolvedValue(holders),
    syncEmployeeGroupKeys: vi.fn().mockResolvedValue([]),
    listForEmployee: vi.fn().mockResolvedValue([]),
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
  } as unknown as AuthzService & {
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
    groupRepo,
    employeeGroupRepo,
    employeePermissionRepo,
    authz,
    db as never,
    audit as never,
  );

  return {
    service,
    groupRepo,
    employeeGroupRepo,
    employeePermissionRepo,
    authz,
    holders,
    audit,
    TX,
    employeeLookup,
  };
}

describe('AuthzAdminService — the audit entry rides the mutation', () => {
  /*
   * WHY THIS IS ASSERTED HERE OF ALL PLACES. "Who granted which group to whom" is the first question an
   * access review asks, and these writes were fire-and-forget: the grant could commit while the entry was
   * lost, leaving the review with no answer. The `tx` in the assertion IS the guarantee.
   */
  it('records a permission change inside the transaction that made it', async () => {
    const { service, audit, TX } = build();

    await service.setGroupPermissions('group-1', ['asset.read'], actor);

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'group.permissions_updated' }),
      TX,
    );
  });

  it('records a revocation inside its transaction', async () => {
    const { service, employeeGroupRepo, audit, TX } = build();
    employeeGroupRepo.findById.mockResolvedValue({
      id: 'assign-1',
      employeeId: 'user-9',
      groupId: 'group-1',
      scopeType: 'global',
      scopeId: null,
    });

    await service.revokeEmployeeGroup('assign-1', actor);

    expect(employeeGroupRepo.revoke).toHaveBeenCalledWith('assign-1', TX);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'group.revoked' }),
      TX,
    );
  });
});

describe('AuthzAdminService — group-definition changes', () => {
  it('invalidates every holder when a group’s permissions change', async () => {
    const { service, authz, holders } = build();

    await service.setGroupPermissions('group-1', ['asset.read'], actor);

    for (const employeeId of holders) {
      expect(authz.invalidate).toHaveBeenCalledWith(employeeId);
    }
    expect(authz.invalidate).toHaveBeenCalledTimes(holders.length);
  });

  it('does not re-sync group claims when only permissions change', async () => {
    // `employees.groups` holds group KEYS, which this operation does not touch.
    // Re-syncing would be a pointless write on every holder.
    const { service, employeeGroupRepo } = build();

    await service.setGroupPermissions('group-1', ['asset.read'], actor);

    expect(employeeGroupRepo.syncEmployeeGroupKeys).not.toHaveBeenCalled();
  });

  it('invalidates AND re-syncs claims when a group is deleted', async () => {
    // Deleting a group makes both caches wrong: the permission cache still grants its
    // codes, and `employees.groups` still lists its key.
    const { service, authz, employeeGroupRepo, holders } = build();

    await service.deleteGroup('group-1', actor);

    for (const employeeId of holders) {
      expect(authz.invalidate).toHaveBeenCalledWith(employeeId);
      expect(employeeGroupRepo.syncEmployeeGroupKeys).toHaveBeenCalledWith(employeeId);
    }
  });

  it('reads the holders BEFORE deleting the group', async () => {
    // `employee_groups.group_id` is ON DELETE CASCADE, so enumerating holders
    // after the delete returns nobody and silently invalidates nothing.
    const calls: string[] = [];
    const { service, groupRepo, employeeGroupRepo } = build();
    employeeGroupRepo.listEmployeeIdsForGroup.mockImplementation(() => {
      calls.push('list');
      return Promise.resolve(['user-a']);
    });
    groupRepo.delete.mockImplementation(() => {
      calls.push('delete');
      return Promise.resolve();
    });

    await service.deleteGroup('group-1', actor);

    expect(calls).toEqual(['list', 'delete']);
  });

  it('refuses to delete a system group, and touches no cache', async () => {
    const { service, groupRepo, authz } = build({ system: true });

    await expect(service.deleteGroup('group-1', actor)).rejects.toMatchObject({
      code: 'GROUP_IMMUTABLE',
    });
    expect(groupRepo.delete).not.toHaveBeenCalled();
    expect(authz.invalidate).not.toHaveBeenCalled();
  });

  it('is a no-op on caches when a group has no holders', async () => {
    const { service, authz } = build({ holders: [] });

    await service.setGroupPermissions('group-1', ['asset.read'], actor);

    expect(authz.invalidate).not.toHaveBeenCalled();
  });
});

describe('AuthzAdminService.syncEmployeeGroupsByKeys — the Entra App Role reconcile', () => {
  /** Groups `employee`, `hr` and `admin` exist; `current` is what the person holds globally. */
  function buildSync(current: Array<{ id: string; groupId: string }>) {
    const t = build();
    const groups = [
      { id: 'r-employee', key: 'employee' },
      { id: 'r-hr', key: 'hr' },
      { id: 'r-admin', key: 'admin' },
    ];
    t.groupRepo.list.mockResolvedValue(groups);
    t.employeeGroupRepo.listForEmployee.mockResolvedValue(
      current.map((a) => ({ ...a, scopeType: 'global' })),
    );
    t.employeeGroupRepo.assign.mockResolvedValue({ id: 'new' });
    t.employeeGroupRepo.revoke.mockResolvedValue(undefined);
    return t;
  }
  const assigned = (t: ReturnType<typeof buildSync>) =>
    t.employeeGroupRepo.assign.mock.calls.map((c) => (c[0] as { groupId: string }).groupId);
  const revoked = (t: ReturnType<typeof buildSync>) =>
    t.employeeGroupRepo.revoke.mock.calls.map((c) => c[0] as string);

  it('with no group claim and the floor, a newcomer holds `employee` and NOTHING else', async () => {
    const t = buildSync([]);

    await t.service.syncEmployeeGroupsByKeys('u', [], actor, 'employee');

    expect(assigned(t)).toEqual(['r-employee']);
  });

  it('only groups opshub has never heard of count as no claim: the floor applies, nothing unknown is granted', async () => {
    const t = buildSync([]);

    await t.service.syncEmployeeGroupsByKeys('u', ['SuperUser', 'root'], actor, 'employee');

    expect(assigned(t)).toEqual(['r-employee']);
  });

  it('the floor is NOT added to groups the token does name', async () => {
    const t = buildSync([]);

    await t.service.syncEmployeeGroupsByKeys('u', ['hr'], actor, 'employee');

    expect(assigned(t)).toEqual(['r-hr']);
  });

  it('DEMOTES at the next sign-in: an App Role removed in Entra is revoked, and the person falls to the floor', async () => {
    const t = buildSync([
      { id: 'a-admin', groupId: 'r-admin' },
      { id: 'a-hr', groupId: 'r-hr' },
    ]);

    await t.service.syncEmployeeGroupsByKeys('u', [], actor, 'employee');

    expect(revoked(t).sort()).toEqual(['a-admin', 'a-hr']);
    expect(assigned(t)).toEqual(['r-employee']);
  });

  it('without a floor, an empty claim leaves no group (the original contract is unchanged)', async () => {
    const t = buildSync([]);

    await t.service.syncEmployeeGroupsByKeys('u', [], actor);

    expect(assigned(t)).toEqual([]);
  });

  it('a missing floor group does not fail the sign-in or grant anything else', async () => {
    const t = buildSync([]);
    t.groupRepo.list.mockResolvedValue([{ id: 'r-hr', key: 'hr' }] as never);

    await t.service.syncEmployeeGroupsByKeys('u', [], actor, 'employee');

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

  /** What the repository answers for `storedGrant`: a fresh insert, unless a case says otherwise. */
  function grantResult(
    outcome: 'created' | 'renewed' | 'unchanged' = 'created',
    previous: (Omit<typeof storedGrant, 'expiresAt'> & { expiresAt: Date | null }) | null = null,
  ) {
    return { grant: storedGrant, outcome, previous };
  }

  it('records the grant inside its transaction and drops the employee’s cached permissions', async () => {
    const { service, authz, employeePermissionRepo, audit, TX } = build();
    authz.resolve.mockResolvedValue({
      'asset.read': [{ type: 'global', id: null }],
    });
    employeePermissionRepo.grant.mockResolvedValue(grantResult());

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

  it('audits a renewal with the expired grant it replaced', async () => {
    const { service, authz, employeePermissionRepo, audit, TX } = build();
    authz.resolve.mockResolvedValue({ 'asset.read': [{ type: 'global', id: null }] });
    const expired = {
      ...storedGrant,
      reason: 'last quarter',
      expiresAt: new Date('2026-01-01T00:00:00Z'),
    };
    employeePermissionRepo.grant.mockResolvedValue(grantResult('renewed', expired));

    await service.grantEmployeePermission(grantCommand, actor);

    const [entry, entryTx] = audit.record.mock.calls[0] as [
      { action: string; changes: { before: unknown; after: { reason: string } } },
      unknown,
    ];
    expect(entry.action).toBe('employee_permission.granted');
    expect(entry.changes.before).toEqual({
      reason: 'last quarter',
      expiresAt: '2026-01-01T00:00:00.000Z',
    });
    expect(entry.changes.after.reason).toBe(grantCommand.reason);
    expect(entryTx).toBe(TX);
    expect(authz.invalidate).toHaveBeenCalledWith('emp-1');
  });

  it('writes no entry when a live grant was already held, because nothing changed', async () => {
    const { service, authz, employeePermissionRepo, audit } = build();
    authz.resolve.mockResolvedValue({ 'asset.read': [{ type: 'global', id: null }] });
    employeePermissionRepo.grant.mockResolvedValue(grantResult('unchanged'));

    await expect(service.grantEmployeePermission(grantCommand, actor)).resolves.toBe(storedGrant);

    expect(audit.record).not.toHaveBeenCalled();
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
    employeePermissionRepo.grant.mockResolvedValue(grantResult());

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
