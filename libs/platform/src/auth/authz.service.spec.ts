import { describe, expect, it, vi } from 'vitest';
import { AuthzService } from './authz.service';
import { ScopeEvaluator } from './scope-evaluator';
import type { EffectivePermissions, JwtPayload } from './authz.types';

/**
 * Scope enforcement, and specifically the case that used to be wrong.
 *
 * `check()` read `if (!resource) return true`, and no route in the codebase passed
 * a resource — so every CONSTRAINED grant (`self`/`team`/`dept`/`region`) was
 * enforced as if it were `global`. The RBAC API accepts and stores those scopes, so
 * an operator could grant "asset.write @ dept=QA" and the holder could write every
 * department's assets. The scope was recorded and ignored.
 *
 * These tests pin the corrected rule: a global grant decides on its own; a
 * constrained grant with nothing to check against DENIES.
 */

function serviceWith(effective: EffectivePermissions) {
  const cache = {
    getJson: vi.fn().mockResolvedValue(effective),
    setJson: vi.fn().mockResolvedValue(undefined),
    del: vi.fn().mockResolvedValue(undefined),
  };
  // The DB is never reached: the cache always hits.
  const db = {} as never;
  const service = new AuthzService(db, cache as never, new ScopeEvaluator());
  return { service, cache };
}

const actor = { sub: 'user-1' } as unknown as JwtPayload;

describe('AuthzService.check', () => {
  it('denies when the permission is not held at all', async () => {
    const { service } = serviceWith({ 'asset.read': [{ type: 'global', id: null }] });
    expect(await service.check('user-1', 'asset.write')).toBe(false);
  });

  it('allows a global grant with no resource to check', async () => {
    const { service } = serviceWith({ 'asset.write': [{ type: 'global', id: null }] });
    expect(await service.check('user-1', 'asset.write')).toBe(true);
  });

  it('DENIES a constrained grant when the route declares no scope', async () => {
    // The regression this file exists for. Before the fix this returned true and
    // the dept limit did nothing.
    const { service } = serviceWith({ 'asset.write': [{ type: 'dept', id: 'QA' }] });
    expect(await service.check('user-1', 'asset.write', undefined, actor)).toBe(false);
  });

  it('denies a constrained grant when the principal is missing', async () => {
    // `self` is meaningless without someone to be, so this cannot be allowed either.
    const { service } = serviceWith({ 'asset.write': [{ type: 'self', id: null }] });
    expect(await service.check('user-1', 'asset.write', { ownerId: 'user-1' })).toBe(false);
  });

  it('allows a self grant on the caller’s own resource', async () => {
    const { service } = serviceWith({ 'workforce.read': [{ type: 'self', id: null }] });
    expect(await service.check('user-1', 'workforce.read', { ownerId: 'user-1' }, actor)).toBe(
      true,
    );
  });

  it('denies a self grant on someone else’s resource', async () => {
    const { service } = serviceWith({ 'workforce.read': [{ type: 'self', id: null }] });
    expect(await service.check('user-1', 'workforce.read', { ownerId: 'user-2' }, actor)).toBe(
      false,
    );
  });

  it('matches a dept grant against the resource’s department name', async () => {
    // `scope_id` holds the department NAME, because employees.department is a
    // varchar and there is no departments table to key against.
    const { service } = serviceWith({ 'employee.read': [{ type: 'dept', id: 'QA' }] });
    expect(await service.check('user-1', 'employee.read', { deptId: 'QA' }, actor)).toBe(true);
    expect(await service.check('user-1', 'employee.read', { deptId: 'Finance' }, actor)).toBe(
      false,
    );
  });

  it('lets a global grant win even when a narrower one is also held', async () => {
    // Scopes are additive: holding both must not be more restrictive than holding
    // only the broad one.
    const { service } = serviceWith({
      'asset.write': [
        { type: 'dept', id: 'QA' },
        { type: 'global', id: null },
      ],
    });
    expect(await service.check('user-1', 'asset.write', undefined, actor)).toBe(true);
  });

  it('honours a module wildcard, and keeps its scope', async () => {
    // `asset.*` covers `asset.write`; the scope on that grant still applies.
    const { service } = serviceWith({ 'asset.*': [{ type: 'self', id: null }] });
    expect(await service.check('user-1', 'asset.write', { ownerId: 'user-1' }, actor)).toBe(true);
    expect(await service.check('user-1', 'asset.write', { ownerId: 'user-2' }, actor)).toBe(false);
  });

  it('lets the super-admin wildcard through regardless of scope shape', async () => {
    const { service } = serviceWith({ '*': [{ type: 'global', id: null }] });
    expect(await service.check('user-1', 'security.manage')).toBe(true);
  });
});

/**
 * `globalHoldersOf` — who gets told a request is waiting.
 *
 * WHAT IT IS FOR. The request engine used to notify `assigneeId`, which no production path sets, so
 * raising a request told nobody. It now asks this for the people the step's permission admits.
 *
 * WHAT THESE TESTS CAN AND CANNOT REACH. The `scopeType = 'global'` and expiry rules are SQL, and a
 * mocked executor returns whatever rows it is handed — so a mutation deleting the scope filter passes
 * here no matter what is asserted. That half is pinned in
 * `test/e2e/request-approver-notification.e2e.spec.ts` against a real database, and saying so here
 * matters: the coverage looks complete otherwise.
 *
 * What IS reachable is the TypeScript half — that coverage is decided by the catalogue's
 * `permissionGrants` rather than a string compare, so `*` and a module-wide `asset.*` both count, and
 * that one person holding a permission through two roles is notified once.
 */
function serviceWithRows(rows: { userId: string; permissionKey: string }[]) {
  const chain = { where: vi.fn().mockResolvedValue(rows) };
  const db = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({ innerJoin: vi.fn().mockReturnValue(chain) }),
    }),
  };
  const cache = {
    getJson: vi.fn().mockResolvedValue(null),
    setJson: vi.fn().mockResolvedValue(undefined),
    del: vi.fn().mockResolvedValue(undefined),
  };
  return new AuthzService(db as never, cache as never, new ScopeEvaluator());
}

describe('AuthzService.globalHoldersOf', () => {
  it('returns the holders of an exact permission', async () => {
    const service = serviceWithRows([
      { userId: 'user-a', permissionKey: 'workforce.approve' },
      { userId: 'user-b', permissionKey: 'asset.read' },
    ]);
    expect(await service.globalHoldersOf('workforce.approve')).toEqual(['user-a']);
  });

  it('counts the `*` wildcard, so an administrator is notified', async () => {
    // Read through `permissionGrants`, not a string compare. An admin holds `*` and nothing else.
    const service = serviceWithRows([{ userId: 'user-admin', permissionKey: '*' }]);
    expect(await service.globalHoldersOf('workforce.approve')).toEqual(['user-admin']);
  });

  it('counts a module-wide grant', async () => {
    // `check()` honours `asset.*` for `asset.write`; a second implementation here that only matched
    // exact codes would silently leave those holders uninformed.
    const service = serviceWithRows([{ userId: 'user-mod', permissionKey: 'workforce.*' }]);
    expect(await service.globalHoldersOf('workforce.approve')).toEqual(['user-mod']);
  });

  it('names a person once even when two roles grant the permission', async () => {
    // Two rows, one human. Twice would be two notifications for one request.
    const service = serviceWithRows([
      { userId: 'user-a', permissionKey: 'workforce.approve' },
      { userId: 'user-a', permissionKey: '*' },
    ]);
    expect(await service.globalHoldersOf('workforce.approve')).toEqual(['user-a']);
  });

  it('returns nobody rather than throwing when the query fails', async () => {
    /*
     * The caller is notification fan-out inside the submit transaction. A request that was submitted
     * successfully must not roll back because nobody could be told about it — the inbox does not
     * depend on this, since the queue is computed from permissions at read time.
     */
    const db = {
      select: vi.fn().mockImplementation(() => {
        throw new Error('connection reset');
      }),
    };
    const cache = {
      getJson: vi.fn().mockResolvedValue(null),
      setJson: vi.fn(),
      del: vi.fn(),
    };
    const service = new AuthzService(db as never, cache as never, new ScopeEvaluator());
    await expect(service.globalHoldersOf('workforce.approve')).resolves.toEqual([]);
  });
});
