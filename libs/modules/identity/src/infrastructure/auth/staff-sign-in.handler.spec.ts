import { describe, expect, it, vi } from 'vitest';
import { employees } from '../../../../../../db/schema';
import {
  DEFAULT_ROLE_KEY,
  StaffSignInHandler,
  StaffSignInRefusedError,
  type StaffSignIn,
} from './staff-sign-in.handler';

/**
 * identity's `hooks.onStaffSignIn`: the product's half of a Microsoft sign-in, and the place the access model
 * is enforced (see the handler's docblock). It runs on EVERY sign-in and a throw refuses the sign-in, so what
 * matters is what it refuses, that it reconciles every time, and that it never swallows a failure.
 */

const USER = { id: 'user-1', email: 'Jane@QNSC.vn', name: 'Jane' };
const CLAIMS = { oid: 'oid-1', email: 'jane@qnsc.vn', guest: false, roles: ['hr'] };

function signIn(over: Partial<StaffSignIn['claims']> = {}, user = USER): StaffSignIn {
  return { user, claims: { ...CLAIMS, ...over } };
}

/** `existing` is what the employee lookup (by id, by email, by Entra oid) returns. */
function setup(
  sync = vi.fn().mockResolvedValue(undefined),
  existing: Array<{ id: string; status: string }> = [],
) {
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
  const insert = vi.fn().mockReturnValue({ values });
  const where = vi.fn().mockResolvedValue(existing);
  const select = vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where }) });
  const handler = new StaffSignInHandler(
    { insert, select } as never,
    {
      syncUserRolesByKeys: sync,
    } as never,
  );
  return { handler, insert, values, onConflictDoUpdate, sync, select };
}

describe('StaffSignInHandler: who is let in', () => {
  it('ensures the employee with the USER’s id, a lower-cased email and the Entra object id', async () => {
    const { handler, insert, values } = setup();

    await handler.handle(signIn());

    expect(insert).toHaveBeenCalledWith(employees);
    expect(values).toHaveBeenCalledWith({
      id: 'user-1',
      email: 'jane@qnsc.vn',
      displayName: 'Jane',
      entraOid: 'oid-1',
    });
  });

  it('on a person who already exists, only refreshes the Entra link (HR’s display name stays)', async () => {
    const { handler, onConflictDoUpdate } = setup(undefined, [{ id: 'user-1', status: 'active' }]);

    await handler.handle(signIn());

    const arg = onConflictDoUpdate.mock.calls[0]?.[0] as { target: unknown; set: object };
    expect(arg.target).toBe(employees.id);
    expect(Object.keys(arg.set).sort()).toEqual(['entraOid', 'updatedAt']);
  });

  it('PROVISIONS a person with no employee row: just-in-time access is the access path', async () => {
    const { handler, insert, sync } = setup(undefined, []);

    await handler.handle(signIn({ roles: [] }));

    expect(insert).toHaveBeenCalledWith(employees);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it.each(['active', 'on_leave'])('lets a %s employee in', async (status) => {
    const { handler, sync } = setup(undefined, [{ id: 'user-1', status }]);

    await handler.handle(signIn());

    expect(sync).toHaveBeenCalledTimes(1);
  });
});

describe('StaffSignInHandler: refusals, all BEFORE anything is written', () => {
  async function refused(who: StaffSignIn, existing: Array<{ id: string; status: string }> = []) {
    const t = setup(undefined, existing);
    await expect(t.handler.handle(who)).rejects.toBeInstanceOf(StaffSignInRefusedError);
    expect(t.insert, 'a refused sign-in provisioned an employee').not.toHaveBeenCalled();
    expect(t.sync, 'a refused sign-in changed roles').not.toHaveBeenCalled();
  }

  it('a guest, even if identity let one through (allowGuests flipped by mistake)', async () => {
    await refused(signIn({ guest: true }));
  });

  it.each([
    'someone@gmail.com',
    'someone@qnsc.vn.evil.example',
    'someone@evilqnsc.vn',
    'someone@mail.qnsc.vn',
    'qnsc.vn',
    '@qnsc.vn',
    '',
  ])('an address off the staff domain: %j', async (email) => {
    await refused(signIn({ email }));
  });

  it('an identity user whose address is off the domain, even if the token’s is not', async () => {
    await refused(signIn({}, { ...USER, email: 'jane@example.com' }));
  });

  it('an offboarded employee found by the USER’S ID', async () => {
    await refused(signIn(), [{ id: 'user-1', status: 'offboarded' }]);
  });

  it('an offboarded employee found only by email or Entra oid: the identity user was deleted or never backfilled', async () => {
    // Better Auth created a NEW user (new id) for the returning leaver; a lookup by that id alone finds nobody
    await refused(signIn({}, { ...USER, id: 'brand-new-user' }), [
      { id: 'old-employee-id', status: 'offboarded' },
    ]);
  });

  it('an ACTIVE employee who exists under another id than the identity user: the invariant is broken, fail closed', async () => {
    await refused(signIn({}, { ...USER, id: 'brand-new-user' }), [
      { id: 'old-employee-id', status: 'active' },
    ]);
  });

  it('puts the reason in the log message, never an email address', async () => {
    const { handler } = setup(undefined, [{ id: 'old', status: 'offboarded' }]);
    const error = await handler.handle(signIn({}, { ...USER, id: 'new' })).catch((e: Error) => e);
    expect((error as Error).message).toContain('offboarded');
    expect((error as Error).message).not.toMatch(/@/);
  });
});

describe('StaffSignInHandler: roles', () => {
  it('reconciles the roles the token asserts, on EVERY sign-in', async () => {
    const { handler, sync } = setup();

    await handler.handle(signIn({ roles: ['hr', 'manager'] }));
    await handler.handle(signIn({ roles: ['auditor'] }));

    expect(sync).toHaveBeenNthCalledWith(
      1,
      'user-1',
      ['hr', 'manager'],
      { sub: 'user-1', email: USER.email },
      DEFAULT_ROLE_KEY,
    );
    // a role removed in Entra is simply absent from the next claim, and the reconcile revokes it
    expect(sync).toHaveBeenNthCalledWith(
      2,
      'user-1',
      ['auditor'],
      expect.anything(),
      DEFAULT_ROLE_KEY,
    );
  });

  it('passes the claim as it is and `employee` only as a FLOOR: it never adds a role the token did not name', async () => {
    const { handler, sync } = setup();

    await handler.handle(signIn({ roles: [] }));

    expect(DEFAULT_ROLE_KEY).toBe('employee');
    const call = sync.mock.calls[0] as unknown[];
    expect(call[1], 'an empty claim must stay empty: the floor is a separate argument').toEqual([]);
    expect(call[3]).toBe('employee');
  });

  it('REJECTS when the role sync fails: identity then refuses the sign-in rather than mint stale roles', async () => {
    const { handler } = setup(vi.fn().mockRejectedValue(new Error('authz down')));

    await expect(handler.handle(signIn())).rejects.toThrow('authz down');
  });

  it('REJECTS when the employee cannot be written, and does not sync roles for a person it could not record', async () => {
    const { handler, onConflictDoUpdate, sync } = setup();
    onConflictDoUpdate.mockRejectedValue(new Error('db down'));

    await expect(handler.handle(signIn())).rejects.toThrow('db down');
    expect(sync).not.toHaveBeenCalled();
  });
});
