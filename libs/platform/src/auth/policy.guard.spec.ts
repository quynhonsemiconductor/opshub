/**
 * PolicyGuard's fail-closed behaviour.
 *
 * The guard used to `return true` when it found no metadata, so a handler nobody decorated was
 * open to every authenticated caller — `SessionAuthGuard` proved who you were and then nothing
 * checked whether you may. These tests pin the reversal, and the acceptance of the four
 * declaration shapes that legitimately carry no permission code.
 *
 * The guard is only half the fix: it cannot run where it is not mounted, and neither
 * `@Public()` nor a bare `@Auth()` mounts it. `route-authz-audit.spec.ts` covers the half that
 * has no blind spot.
 */
import { describe, expect, it, vi } from 'vitest';
import { PermissionDeniedException } from '../errors/exceptions';
import { AUTHZ_MODE_KEY, PERMISSION_KEY, type AuthzMode } from './decorators';
import { PolicyGuard } from './policy.guard';
import type { AuthzService } from './authz.service';
import type { ResourceScopeResolver } from './resource-scope.resolver';

/** Reflector stub returning whatever the route "declared", keyed by metadata key. */
function reflectorOf(meta: Record<string, unknown>) {
  return { getAllAndOverride: (key: string) => meta[key] } as never;
}

function contextOf(user: unknown = { sub: 'user-1' }) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user, params: {}, query: {}, body: {} }) }),
    getHandler: () => function handler() {},
    getClass: () => class TestController {},
  } as never;
}

const scopes = {} as ResourceScopeResolver;

describe('PolicyGuard', () => {
  it('DENIES a route that declared nothing', async () => {
    const check = vi.fn();
    const guard = new PolicyGuard(reflectorOf({}), { check } as unknown as AuthzService, scopes);

    await expect(guard.canActivate(contextOf())).rejects.toThrow(PermissionDeniedException);
    // Not a permission decision — there was no permission to check. Calling the service would
    // mean the guard had invented a requirement.
    expect(check).not.toHaveBeenCalled();
  });

  it.each([
    ['self-scoped', { mode: 'self-scoped', reason: 'the caller' }],
    ['in-service', { mode: 'in-service', reason: 'runtime', pinnedBy: 'x.spec.ts' }],
    ['shared-read', { mode: 'shared-read', reason: 'reference data' }],
    ['gap', { mode: 'gap', reason: 'known hole' }],
  ] as [string, AuthzMode][])('allows an explicitly declared %s route', async (_name, mode) => {
    const check = vi.fn();
    const guard = new PolicyGuard(
      reflectorOf({ [AUTHZ_MODE_KEY]: mode }),
      { check } as unknown as AuthzService,
      scopes,
    );

    await expect(guard.canActivate(contextOf())).resolves.toBe(true);
    expect(check).not.toHaveBeenCalled();
  });

  it('still enforces a permission when one is declared', async () => {
    const authz = { check: vi.fn().mockResolvedValue(false) } as unknown as AuthzService;
    const guard = new PolicyGuard(
      reflectorOf({ [PERMISSION_KEY]: { permission: 'asset.read' } }),
      authz,
      scopes,
    );

    await expect(guard.canActivate(contextOf())).rejects.toThrow(/Missing permission: asset.read/);
  });

  it('allows a declared permission the principal holds', async () => {
    const authz = { check: vi.fn().mockResolvedValue(true) } as unknown as AuthzService;
    const guard = new PolicyGuard(
      reflectorOf({ [PERMISSION_KEY]: { permission: 'asset.read' } }),
      authz,
      scopes,
    );

    await expect(guard.canActivate(contextOf())).resolves.toBe(true);
  });

  it('prefers a declared permission over a mode when both are present', async () => {
    // A route carrying both is a mistake, but the permission is the stronger claim and must
    // win — the alternative is a mode silently disabling a real check.
    const check = vi.fn().mockResolvedValue(false);
    const guard = new PolicyGuard(
      reflectorOf({
        [PERMISSION_KEY]: { permission: 'asset.read' },
        [AUTHZ_MODE_KEY]: { mode: 'self-scoped', reason: 'should not win' },
      }),
      { check } as unknown as AuthzService,
      scopes,
    );

    await expect(guard.canActivate(contextOf())).rejects.toThrow(PermissionDeniedException);
    expect(check).toHaveBeenCalled();
  });
});
