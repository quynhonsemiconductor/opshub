import { Injectable, Logger } from '@nestjs/common';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { InjectDrizzle, type DrizzleDB } from '../database/drizzle.provider';
import { CacheService } from '@quynhonsemiconductor/platform-cache';
import { rolePermissions, userRoleAssignments } from '../../../../db/schema';
import { ScopeEvaluator } from './scope-evaluator';
import { permissionGrants } from '@shared-kernel';
import {
  type EffectivePermissions,
  type JwtPayload,
  type ResourceAttrs,
  type Scope,
} from './authz.types';

/**
 * Resolves and caches a principal's effective permissions, and answers
 * permission checks for the PolicyGuard.
 *
 * Resolution is a single indexed join (assignments ⋈ role_permissions) filtered
 * to non-expired grants, cached in Valkey under a per-user key with a bounded
 * TTL. The cache is shared across replicas, so {@link invalidate} busts every
 * instance at once; the TTL is the safety net for role-definition edits.
 *
 * Fail-closed: any resolution error denies access (returns empty permissions).
 */
@Injectable()
export class AuthzService {
  private readonly logger = new Logger(AuthzService.name);
  private static readonly CACHE_TTL_SECONDS = 300;
  private static readonly CACHE_PREFIX = 'authz:perms:';

  constructor(
    @InjectDrizzle() private readonly db: DrizzleDB,
    private readonly cache: CacheService,
    private readonly scopes: ScopeEvaluator,
  ) {}

  private cacheKey(userId: string): string {
    return `${AuthzService.CACHE_PREFIX}${userId}`;
  }

  /** Effective permissions for a user (cached). Empty map on any failure. */
  async resolve(userId: string): Promise<EffectivePermissions> {
    const key = this.cacheKey(userId);
    const cached = await this.cache.getJson<EffectivePermissions>(key);
    if (cached) return cached;

    try {
      const rows = await this.db
        .select({
          permissionKey: rolePermissions.permissionKey,
          scopeType: userRoleAssignments.scopeType,
          scopeId: userRoleAssignments.scopeId,
        })
        .from(userRoleAssignments)
        .innerJoin(rolePermissions, eq(rolePermissions.roleId, userRoleAssignments.roleId))
        .where(
          and(
            eq(userRoleAssignments.userId, userId),
            or(
              isNull(userRoleAssignments.expiresAt),
              gt(userRoleAssignments.expiresAt, new Date()),
            ),
          ),
        );

      const effective: EffectivePermissions = {};
      for (const row of rows) {
        const scope: Scope = { type: row.scopeType, id: row.scopeId };
        (effective[row.permissionKey] ??= []).push(scope);
      }

      await this.cache.setJson(key, effective, AuthzService.CACHE_TTL_SECONDS);
      return effective;
    } catch (err) {
      // Fail closed — never grant access when resolution fails.
      this.logger.error({ err, userId }, 'Permission resolution failed — denying');
      return {};
    }
  }

  /**
   * Everyone who holds `permission` UNCONSTRAINED — the exact set that {@link check} would pass
   * when no resource is supplied.
   *
   * WHY IT MIRRORS `check` RATHER THAN LISTING EVERY HOLDER. A constrained grant (`self`, `team`,
   * `dept`, `region`) cannot be evaluated without a resource, and `check` therefore DENIES it. So a
   * caller holding `request.approve` only on their own team cannot approve an arbitrary request, and
   * telling them one is waiting would be an invitation to a 403. `scopeType = 'global'` is that rule
   * expressed as a query.
   *
   * Coverage is decided by `permissionGrants`, the same catalogue function `check` uses, so a
   * module-wide grant (`asset.*`) and the `*` wildcard are honoured here too. Filtering in TypeScript
   * rather than SQL is deliberate: the catalogue owns what covers what, and a `LIKE` pattern here
   * would be a second, quietly diverging implementation of it.
   *
   * NOT CACHED, unlike `resolve`. This is keyed on a permission rather than a user, so it would need
   * invalidating on every role edit, assignment and expiry — three more places to get wrong, to save
   * one indexed join on a path that runs when a request is submitted, not per HTTP call.
   *
   * Accepts an executor so it can read inside the caller's transaction and see the same snapshot the
   * rest of that unit of work sees.
   */
  async globalHoldersOf(permission: string, executor?: DrizzleDB): Promise<string[]> {
    const db = executor ?? this.db;
    try {
      const rows = await db
        .select({
          userId: userRoleAssignments.userId,
          permissionKey: rolePermissions.permissionKey,
        })
        .from(userRoleAssignments)
        .innerJoin(rolePermissions, eq(rolePermissions.roleId, userRoleAssignments.roleId))
        .where(
          and(
            eq(userRoleAssignments.scopeType, 'global'),
            or(
              isNull(userRoleAssignments.expiresAt),
              gt(userRoleAssignments.expiresAt, new Date()),
            ),
          ),
        );

      const holders = new Set<string>();
      for (const row of rows) {
        if (permissionGrants([row.permissionKey], permission)) holders.add(row.userId);
      }
      return [...holders];
    } catch (err) {
      /*
       * EMPTY, NOT A THROW. The only caller is notification fan-out, and a request that was
       * submitted successfully must not be rolled back because nobody could be told about it. The
       * inbox does not depend on this — `decidableByPredicate` computes the queue from permissions
       * at read time — so the failure costs a prompt, not the work.
       */
      this.logger.error(
        { err, permission },
        'Could not resolve permission holders — notifying none',
      );
      return [];
    }
  }

  /** Drop a user's cached permissions after a role/assignment change. */
  async invalidate(userId: string): Promise<void> {
    await this.cache.del(this.cacheKey(userId));
  }

  /**
   * Does the principal hold `permission` for this resource?
   *
   * A `global` grant needs no resource: there is no constraint to verify. A
   * CONSTRAINED grant (`self`/`team`/`dept`/`region`) needs one, and if the route
   * declared no scope the answer is DENY — not allow.
   *
   * That last rule is the point. This used to read `if (!resource) return true`,
   * and since no route declared a scope, every constrained grant was enforced as if
   * it were global: an operator could assign "asset.write @ team=X" through the RBAC
   * API — which validates and stores the scope — and the holder could write every
   * team's assets. The scope was recorded and ignored.
   *
   * Failing closed inverts that: an unverifiable constraint denies and logs which
   * route needs a scope descriptor, so the gap surfaces as a 403 with a breadcrumb
   * instead of silent over-permission.
   */
  async check(
    userId: string,
    permission: string,
    resource?: ResourceAttrs,
    user?: JwtPayload,
  ): Promise<boolean> {
    const effective = await this.resolve(userId);

    // Which of the holder's codes cover `permission` is decided by the catalogue's
    // `permissionGrants` — the same function the frontend gating and the seed use —
    // rather than re-implemented here. Previously this checked only `*` and an
    // exact match, so a module-wide grant (`asset.*`) would have been silently
    // ignored by the guard while the UI showed the capability as held.
    const grants = Object.entries(effective)
      .filter(([code]) => permissionGrants([code], permission))
      .flatMap(([, scopes]) => scopes);
    if (grants.length === 0) return false;

    // An unconstrained grant is decisive on its own.
    if (grants.some((scope) => scope.type === 'global')) return true;

    // Everything left is constrained. Without a resource (or a principal to compare
    // `self` against) the constraint cannot be evaluated, so deny.
    if (!resource || !user) {
      this.logger.warn(
        { userId, permission, scopes: grants.map((g) => g.type) },
        'Denying: caller holds this permission only in a constrained scope, but the ' +
          'route declares no scope to check it against — add a scope descriptor to ' +
          '@RequirePermission, or grant the permission globally',
      );
      return false;
    }

    return this.scopes.anyMatches(grants, resource, user);
  }
}
