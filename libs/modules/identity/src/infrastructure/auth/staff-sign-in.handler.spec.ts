import { describe, expect, it, vi } from 'vitest';
import { employees } from '../../../../../../db/schema';
import {
  DEFAULT_ROLE_KEY,
  StaffSignInHandler,
  StaffSignInRefusedError,
} from './staff-sign-in.handler';

/**
 * identity's `hooks.onStaffSignIn`: the product's half of a Microsoft sign-in. It runs on EVERY sign-in and a
 * throw refuses the sign-in, so what matters is that it reconciles every time and never swallows a failure.
 */

const USER = { id: 'user-1', email: 'Jane@QNSC.vn', name: 'Jane' };

function setup(
  sync = vi.fn().mockResolvedValue(undefined),
  existing: Array<{ status: string }> = [],
) {
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
  const insert = vi.fn().mockReturnValue({ values });
  const limit = vi.fn().mockResolvedValue(existing);
  const select = vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit }) }),
  });
  const handler = new StaffSignInHandler(
    { insert, select } as never,
    {
      syncUserRolesByKeys: sync,
    } as never,
  );
  return { handler, insert, values, onConflictDoUpdate, sync };
}

describe('StaffSignInHandler', () => {
  it('ensures the employee with the USER’s id, a lower-cased email and the Entra object id', async () => {
    const { handler, insert, values } = setup();

    await handler.handle({ user: USER, claims: { oid: 'oid-1', roles: ['hr'] } });

    expect(insert).toHaveBeenCalledWith(employees);
    expect(values).toHaveBeenCalledWith({
      id: 'user-1',
      email: 'jane@qnsc.vn',
      displayName: 'Jane',
      entraOid: 'oid-1',
    });
  });

  it('on a person who already exists, only refreshes the Entra link (HR’s display name stays)', async () => {
    const { handler, onConflictDoUpdate } = setup();

    await handler.handle({ user: USER, claims: { oid: 'oid-1', roles: ['hr'] } });

    const arg = onConflictDoUpdate.mock.calls[0]?.[0] as { target: unknown; set: object };
    expect(arg.target).toBe(employees.id);
    expect(Object.keys(arg.set).sort()).toEqual(['entraOid', 'updatedAt']);
  });

  it('reconciles the roles the token asserts, on every sign-in', async () => {
    const { handler, sync } = setup();

    await handler.handle({ user: USER, claims: { oid: 'o', roles: ['hr', 'manager'] } });
    await handler.handle({ user: USER, claims: { oid: 'o', roles: ['auditor'] } });

    expect(sync).toHaveBeenNthCalledWith(1, 'user-1', ['hr', 'manager'], {
      sub: 'user-1',
      email: USER.email,
    });
    expect(sync).toHaveBeenNthCalledWith(2, 'user-1', ['auditor'], expect.anything());
  });

  it('a token with no role is the `employee` role', async () => {
    const { handler, sync } = setup();

    await handler.handle({ user: USER, claims: { oid: 'o', roles: [] } });

    expect(DEFAULT_ROLE_KEY).toBe('employee');
    expect(sync).toHaveBeenCalledWith('user-1', ['employee'], expect.anything());
  });

  it('REJECTS when the role sync fails: identity then refuses the sign-in rather than mint stale roles', async () => {
    const { handler } = setup(vi.fn().mockRejectedValue(new Error('authz down')));

    await expect(
      handler.handle({ user: USER, claims: { oid: 'o', roles: ['hr'] } }),
    ).rejects.toThrow('authz down');
  });

  it('REJECTS when the employee cannot be written, and does not sync roles for a person it could not record', async () => {
    const { handler, onConflictDoUpdate, sync } = setup();
    onConflictDoUpdate.mockRejectedValue(new Error('db down'));

    await expect(
      handler.handle({ user: USER, claims: { oid: 'o', roles: ['hr'] } }),
    ).rejects.toThrow('db down');
    expect(sync).not.toHaveBeenCalled();
  });

  it('REFUSES an offboarded employee, before writing or syncing anything', async () => {
    const { handler, insert, sync } = setup(undefined, [{ status: 'offboarded' }]);

    await expect(
      handler.handle({ user: USER, claims: { oid: 'o', roles: ['admin'] } }),
    ).rejects.toBeInstanceOf(StaffSignInRefusedError);
    expect(insert).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });

  it.each(['active', 'on_leave'])('lets a %s employee in', async (status) => {
    const { handler, sync } = setup(undefined, [{ status }]);

    await handler.handle({ user: USER, claims: { oid: 'o', roles: ['hr'] } });

    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('does not refuse a person with no employee row: v7’s just-in-time provisioning is kept', async () => {
    const { handler, insert } = setup(undefined, []);

    await handler.handle({ user: USER, claims: { oid: 'o', roles: [] } });

    expect(insert).toHaveBeenCalledWith(employees);
  });
});
