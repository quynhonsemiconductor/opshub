/**
 * OffboardingTypeDef.onApprove() unit tests.
 *
 * Tests that the 5 cleanup operations (employee status, role assignments,
 * access grants, asset assignments + asset status reset, ban + session
 * removal) are all called with the correct table arguments, and that the Entra disable +
 * session revoke are QUEUED in the same transaction rather than called.
 *
 * Tables are identified by object identity (imported singleton references),
 * not by name introspection.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OffboardingTypeDef } from './offboarding.type-def';
import {
  employees,
  userRoleAssignments,
  accessGrants,
  assetAssignments,
  assets,
  session as identitySession,
  user as identityUser,
} from '../../../../../db/schema';

// ── Mock tx builder ───────────────────────────────────────────────────────────

/**
 * Builds a mock DbExecutor that records which table each update/delete targets.
 * Tables are identified by object identity (the actual imported Drizzle table
 * objects), so assertions can be made with `table === employees` etc.
 *
 * `assetReturnRows` controls what asset_assignments.returning() resolves to.
 */
function makeTx(
  assetReturnRows: Array<{ assetId: string }> = [],
  roleReturnRows: Array<{ id: string; roleId: string }> = [],
  sessionReturnRows: Array<{ id: string }> = [{ id: 'token-1' }],
  entraOid: string | null = null,
) {
  const updateCalls: Array<{ table: unknown; chain: ReturnType<typeof makeUpdateChain> }> = [];
  const deleteCalls: Array<{ table: unknown }> = [];

  function makeUpdateChain(returning: unknown[] = []) {
    const c = {
      set: vi.fn(),
      where: vi.fn(),
      returning: vi.fn().mockResolvedValue(returning),
    };
    c.set.mockReturnValue(c);
    c.where.mockImplementation(() => {
      return Object.assign(Promise.resolve(returning), c);
    });
    return c;
  }

  const updateMock = vi.fn().mockImplementation((table: unknown) => {
    const returning = table === assetAssignments ? assetReturnRows : [];
    const chain = makeUpdateChain(returning);
    updateCalls.push({ table, chain });
    return chain;
  });

  const deleteMock = vi.fn().mockImplementation((table: unknown) => {
    deleteCalls.push({ table });
    // `.returning()` because each removed assignment is audited individually — the chain has to
    // resolve to the removed rows, not to `undefined`.
    const rows = table === identitySession ? sessionReturnRows : roleReturnRows;
    const where = vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(rows) });
    return { where };
  });

  // `select … from … where … limit` — the employee's Entra object id, read inside the transaction.
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(entraOid ? [{ entraOid }] : [{ entraOid: null }]),
  };

  return {
    select: vi.fn().mockReturnValue(selectChain),
    update: updateMock,
    delete: deleteMock,
    _updateCalls: updateCalls,
    _deleteCalls: deleteCalls,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

const EMPLOYEE_ID = 'emp-abc';
const PAYLOAD = { employeeId: EMPLOYEE_ID, employeeEmail: 'alice@example.com' };

describe('OffboardingTypeDef.onApprove()', () => {
  let typeDef: OffboardingTypeDef;
  let record: ReturnType<typeof vi.fn>;
  let invalidate: ReturnType<typeof vi.fn>;
  let enqueue: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    };
    enqueue = vi.fn().mockResolvedValue(true);
    record = vi.fn().mockResolvedValue(undefined);
    invalidate = vi.fn().mockResolvedValue(undefined);
    // One recorder shared by every resource: these tests care WHICH action was recorded, and the
    // resource binding is asserted by the entry's action code rather than by which trail it came from.
    const mockAudit = { forResource: vi.fn().mockReturnValue({ record }) };
    typeDef = new OffboardingTypeDef(
      { register: vi.fn() } as never,
      mockDb as never,
      { enqueue } as never,
      { invalidate } as never,
      mockAudit as never,
      { offboard: vi.fn().mockResolvedValue(undefined), reinstate: vi.fn() },
    );
  });

  /** Actions recorded during the call, in order. */
  const recordedActions = (): string[] => record.mock.calls.map((c) => c[0] as string);

  it('updates employees table (sets status → offboarded)', async () => {
    const tx = makeTx();
    await typeDef.onApprove(PAYLOAD, 'req-1', 'hr-user', tx as never);

    const employeeCall = tx._updateCalls.find((c) => c.table === employees);
    expect(employeeCall).toBeDefined();
    expect(employeeCall!.chain.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'offboarded' }),
    );
  });

  it('deletes user_role_assignments for the employee', async () => {
    const tx = makeTx();
    await typeDef.onApprove(PAYLOAD, 'req-1', 'hr-user', tx as never);

    const roleDeleteCall = tx._deleteCalls.find((c) => c.table === userRoleAssignments);
    expect(roleDeleteCall).toBeDefined();
  });

  it('updates access_grants to set revokedAt (only active grants)', async () => {
    const tx = makeTx();
    await typeDef.onApprove(PAYLOAD, 'req-1', 'hr-user', tx as never);

    const grantCall = tx._updateCalls.find((c) => c.table === accessGrants);
    expect(grantCall).toBeDefined();
    expect(grantCall!.chain.set).toHaveBeenCalledWith(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      expect.objectContaining({ revokedAt: expect.any(Date) }),
    );
  });

  it('marks active asset_assignments as returned', async () => {
    const tx = makeTx([{ assetId: 'asset-1' }]);
    await typeDef.onApprove(PAYLOAD, 'req-1', 'hr-user', tx as never);

    const assignmentCall = tx._updateCalls.find((c) => c.table === assetAssignments);
    expect(assignmentCall).toBeDefined();
    expect(assignmentCall!.chain.set).toHaveBeenCalledWith(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      expect.objectContaining({ returnedAt: expect.any(Date) }),
    );
  });

  it('resets each returned asset to in_stock', async () => {
    const assetReturnRows = [{ assetId: 'asset-A' }, { assetId: 'asset-B' }];
    const tx = makeTx(assetReturnRows);
    await typeDef.onApprove(PAYLOAD, 'req-1', 'hr-user', tx as never);

    const assetCalls = tx._updateCalls.filter((c) => c.table === assets);
    expect(assetCalls).toHaveLength(2);
    for (const call of assetCalls) {
      expect(call.chain.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'in_stock' }));
    }
  });

  it('skips asset status reset when no active assignments exist', async () => {
    const tx = makeTx([]);
    await typeDef.onApprove(PAYLOAD, 'req-1', 'hr-user', tx as never);

    const assetCalls = tx._updateCalls.filter((c) => c.table === assets);
    expect(assetCalls).toHaveLength(0);
  });

  it('bans the identity user (so they cannot sign in again) and deletes every session row', async () => {
    const tx = makeTx();
    await typeDef.onApprove(PAYLOAD, 'req-1', 'hr-user', tx as never);

    const ban = tx._updateCalls.find((c) => c.table === identityUser);
    expect(ban).toBeDefined();
    expect(ban!.chain.set).toHaveBeenCalledWith(
      expect.objectContaining({ banned: true, banReason: 'offboarded' }),
    );
    expect(tx._deleteCalls.some((c) => c.table === identitySession)).toBe(true);
  });

  it('performs all 5 cleanup operations (5 updates + 1 delete)', async () => {
    const tx = makeTx([{ assetId: 'x' }]);
    await typeDef.onApprove(PAYLOAD, 'req-1', 'hr-user', tx as never);
    // employees(status) + employees(roles) + access_grants + asset_assignments + assets(×1) +
    // identity user (ban) = 6 updates. The second `employees` write clears the denormalised role claims;
    // see the comment at that call site for why it is not a post-commit sync.
    expect(tx._updateCalls).toHaveLength(6);
    expect(tx._updateCalls.filter((c) => c.table === employees)).toHaveLength(2);
    // user_role_assignments + identity session rows = 2 deletes
    expect(tx._deleteCalls).toHaveLength(2);
  });

  it('clears the denormalised role claims alongside the assignments', async () => {
    const tx = makeTx([], [{ id: 'a-1', roleId: 'r-1' }]);
    await typeDef.onApprove(PAYLOAD, 'req-1', 'hr-user', tx as never);

    // `employees.roles` feeds the JWT claims and nothing maintained it here, so an offboarded row
    // still listed the roles whose assignments had just been deleted.
    const rolesWrite = tx._updateCalls
      .filter((c) => c.table === employees)
      .find((c) =>
        c.chain.set.mock.calls.some((args) =>
          Array.isArray((args[0] as { roles?: unknown }).roles),
        ),
      );
    expect(rolesWrite, 'no write cleared employees.roles').toBeDefined();
    expect(rolesWrite!.chain.set).toHaveBeenCalledWith(expect.objectContaining({ roles: [] }));
  });

  describe('the audit trail — the evidence an access review reads', () => {
    it('records the status change and the forced logout', async () => {
      const tx = makeTx();
      await typeDef.onApprove(PAYLOAD, 'req-1', 'hr-user', tx as never);

      expect(recordedActions()).toContain('employee.status_changed');
      // `session.revoked`, not `auth.logout`: the holder did not do this to themselves.
      expect(recordedActions()).toContain('session.revoked');
      expect(recordedActions()).not.toContain('auth.logout');
    });

    it('records one entry per role removed, not one for the batch', async () => {
      const tx = makeTx(
        [],
        [
          { id: 'assign-1', roleId: 'role-1' },
          { id: 'assign-2', roleId: 'role-2' },
        ],
      );
      await typeDef.onApprove(PAYLOAD, 'req-1', 'hr-user', tx as never);

      // An access review asks when this person lost THIS role; "2 roles removed" cannot answer it.
      const revocations = record.mock.calls.filter((c) => c[0] === 'role.revoked');
      expect(revocations).toHaveLength(2);
      expect(revocations.map((c) => c[1] as string)).toEqual(['assign-1', 'assign-2']);
    });

    it('records one entry per asset returned', async () => {
      const tx = makeTx([{ assetId: 'asset-A' }, { assetId: 'asset-B' }]);
      await typeDef.onApprove(PAYLOAD, 'req-1', 'hr-user', tx as never);

      const returns = record.mock.calls.filter((c) => c[0] === 'asset.unassigned');
      expect(returns.map((c) => c[1] as string)).toEqual(['asset-A', 'asset-B']);
    });

    it("names the APPROVER as the actor, and shares the caller's transaction", async () => {
      const tx = makeTx();
      await typeDef.onApprove(PAYLOAD, 'req-1', 'hr-user', tx as never);

      for (const call of record.mock.calls) {
        expect(call[2]).toMatchObject({ sub: 'hr-user' });
        // With `tx`, the entry commits with the removal it describes and rolls back with it. An
        // entry written outside the transaction can describe a change that never happened.
        expect(call[3], 'an audit entry was written outside the transaction').toBe(tx);
      }
    });

    it('writes no entry for a step that removed nothing', async () => {
      // A leaver with no roles, no assets and no live session. Recording those anyway would put
      // three events in the trail that did not happen.
      const tx = makeTx([], [], []);
      await typeDef.onApprove(PAYLOAD, 'req-1', 'hr-user', tx as never);

      expect(recordedActions()).not.toContain('role.revoked');
      expect(recordedActions()).not.toContain('asset.unassigned');
      expect(recordedActions()).not.toContain('session.revoked');
      // The status change always happened, so it is always recorded.
      expect(recordedActions()).toEqual(['employee.status_changed']);
    });
  });

  describe('the permission cache', () => {
    it('is NOT invalidated inside the transaction', async () => {
      const tx = makeTx();
      await typeDef.onApprove(PAYLOAD, 'req-1', 'hr-user', tx as never);

      // Invalidating before the commit lets a concurrent request miss the cache, re-resolve from
      // uncommitted rows, and cache the OLD permissions again — the same stale state by a longer
      // route. So this must NOT happen here.
      expect(invalidate).not.toHaveBeenCalled();
    });

    it('is invalidated after the commit', async () => {
      await typeDef.afterApprove(PAYLOAD);

      expect(invalidate).toHaveBeenCalledWith(EMPLOYEE_ID);
    });

    it('afterApprove makes no Graph call and queues nothing — the API has no Graph credential', async () => {
      await typeDef.afterApprove(PAYLOAD);

      expect(enqueue).not.toHaveBeenCalled();
    });
  });

  describe('the leaver’s identity session and the Entra account, together', () => {
    it('bans the identity user, deletes the sessions AND queues the Entra reconcile, all in the ONE transaction', async () => {
      const tx = makeTx();
      await typeDef.onApprove(PAYLOAD, 'req-1', 'hr-user', tx as never);

      // the local half: banned, session rows gone, through the transaction handed in
      expect(tx._updateCalls.some((c) => c.table === identityUser)).toBe(true);
      expect(tx._deleteCalls.some((c) => c.table === identitySession)).toBe(true);
      // the Entra half: a task enqueued with that same tx, never a Graph call
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(enqueue.mock.calls[0]?.[1]).toBe(tx);
      // and the order is the safe one: the local ban is written before the task that follows it
      const ban = tx._updateCalls.find((c) => c.table === identityUser)!;
      expect(ban.chain.set.mock.invocationCallOrder[0]).toBeLessThan(
        enqueue.mock.invocationCallOrder[0],
      );
    });
  });

  describe('the Entra account', () => {
    it('is reconciled by a TASK queued in the approval transaction, naming the employee and nothing else', async () => {
      const tx = makeTx();
      await typeDef.onApprove(PAYLOAD, 'req-1', 'hr-user', tx as never);

      // No directory object id in the payload: the worker reads the employee's CURRENT status and Entra
      // id, so the API cannot aim a task at an arbitrary account and a stale task cannot re-enable.
      expect(enqueue.mock.calls.map((c: unknown[]) => c[0])).toEqual([
        { kind: 'entra.account.reconcile', payload: { employeeId: EMPLOYEE_ID } },
      ]);
      // The SAME transaction: roll the approval back and the task does not exist.
      expect(enqueue.mock.calls.every((c: unknown[]) => c[1] === tx)).toBe(true);
    });

    it('is queued after the employee row was set to offboarded, in the same transaction', async () => {
      const tx = makeTx();
      await typeDef.onApprove(PAYLOAD, 'req-1', 'hr-user', tx as never);

      const employeeUpdate = tx._updateCalls.find((c) => c.table === employees)!;
      expect(employeeUpdate.chain.set.mock.invocationCallOrder[0]).toBeLessThan(
        enqueue.mock.invocationCallOrder[0],
      );
    });
  });

  it('onReject is a no-op (mutates no state)', async () => {
    const tx = makeTx();
    await typeDef.onReject(PAYLOAD, 'req-1', 'hr-user', tx as never);
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.delete).not.toHaveBeenCalled();
  });
});

describe('OffboardingTypeDef.afterApprove(): the cached sessions', () => {
  const build = (sessions?: { offboard: ReturnType<typeof vi.fn> }) => {
    const invalidate = vi.fn().mockResolvedValue(undefined);
    const typeDef = new OffboardingTypeDef(
      { register: vi.fn() } as never,
      {} as never,
      { enqueue: vi.fn() } as never,
      { invalidate } as never,
      { forResource: vi.fn().mockReturnValue({ record: vi.fn() }) } as never,
      sessions as never,
    );
    return { typeDef, invalidate };
  };

  it('ends the cached sessions through the SessionRevoker, after the commit', async () => {
    const sessions = { offboard: vi.fn().mockResolvedValue(undefined) };
    const { typeDef } = build(sessions);
    await typeDef.afterApprove(PAYLOAD);
    expect(sessions.offboard).toHaveBeenCalledWith(EMPLOYEE_ID, 'offboarded');
  });

  it('fails loudly when the cache cannot be cleared, instead of leaving a leaver’s cached session behind', async () => {
    const sessions = { offboard: vi.fn().mockRejectedValue(new Error('cache unavailable')) };
    const { typeDef } = build(sessions);
    await expect(typeDef.afterApprove(PAYLOAD)).rejects.toThrow('cache unavailable');
  });

  it('REFUSES where no revoker is bound (the worker): afterApprove throws instead of skipping the cache clear', async () => {
    const { typeDef } = build(undefined);
    await expect(typeDef.afterApprove(PAYLOAD)).rejects.toThrow(/needs a SessionRevoker/);
  });

  it('onApprove refuses BEFORE changing anything where no revoker is bound', async () => {
    const { typeDef } = build(undefined);
    const tx = makeTx();

    await expect(typeDef.onApprove(PAYLOAD, 'req-1', 'hr-user', tx as never)).rejects.toThrow(
      /needs a SessionRevoker/,
    );

    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.delete).not.toHaveBeenCalled();
  });
});
