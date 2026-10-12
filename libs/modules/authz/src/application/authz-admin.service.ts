import { Inject, Injectable } from '@nestjs/common';
import {
  AuthzService,
  ConflictException,
  InjectDrizzle,
  NotFoundException,
  PermissionDeniedException,
  ValidationException,
  type DrizzleDB,
} from '@platform';
import type { Permission, RoleAssignment, RoleWithPermissions, ScopeType } from '@platform';
import {
  AuditService,
  AUDIT_ACTION,
  AUDIT_RESOURCE,
  type ResourceAuditTrail,
} from '@modules/audit';
import {
  ROLE_REPOSITORY,
  type CreateRoleInput,
  type IRoleRepository,
} from '../domain/ports/role.repository';
import {
  ROLE_ASSIGNMENT_REPOSITORY,
  type IRoleAssignmentRepository,
} from '../domain/ports/role-assignment.repository';

export interface Actor {
  sub: string;
  email: string;
}

export interface AssignRoleCommand {
  userId: string;
  roleId: string;
  scopeType?: ScopeType;
  scopeId?: string | null;
  expiresAt?: Date | null;
}

/**
 * Administrative RBAC operations: manage roles/permissions and grant/revoke scoped role assignments.
 *
 * THE AUDIT ENTRY SHARES THE MUTATION'S TRANSACTION. These were fire-and-forget, and of everything in this
 * codebase these are the writes least able to afford it: who granted which role to whom, and who deleted a
 * role, is the first question any access review asks. A grant that committed while its entry was lost left no
 * answer.
 *
 * CACHE BUSTING HAPPENS AFTER THE COMMIT, and cannot be inside it: Valkey is not transactional, so
 * invalidating before the commit would open a window where the cache is empty and the old row still current —
 * a read then repopulates the cache with permissions that are about to change. Invalidating after means the
 * worst case is a stale grant for the few milliseconds until the delete lands, which is the direction that
 * fails safe for a REVOCATION only because the permission cache is also TTL-bounded.
 */
@Injectable()
export class AuthzAdminService {
  private readonly roleTrail: ResourceAuditTrail;
  private readonly assignmentTrail: ResourceAuditTrail;
  private readonly employeeTrail: ResourceAuditTrail;

  constructor(
    @Inject(ROLE_REPOSITORY) private readonly roleRepo: IRoleRepository,
    @Inject(ROLE_ASSIGNMENT_REPOSITORY)
    private readonly assignmentRepo: IRoleAssignmentRepository,
    private readonly authz: AuthzService,
    @InjectDrizzle() private readonly db: DrizzleDB,
    audit: AuditService,
  ) {
    this.roleTrail = audit.forResource(AUDIT_RESOURCE.ROLE);
    this.assignmentTrail = audit.forResource(AUDIT_RESOURCE.ROLE_ASSIGNMENT);
    this.employeeTrail = audit.forResource(AUDIT_RESOURCE.EMPLOYEE);
  }

  // ── Catalog ────────────────────────────────────────────────────────────────

  listRoles(): Promise<RoleWithPermissions[]> {
    return this.roleRepo.list();
  }

  async getRole(id: string): Promise<RoleWithPermissions> {
    const role = await this.roleRepo.findById(id);
    if (!role) throw new NotFoundException('ROLE_NOT_FOUND', `Role ${id} not found`);
    return role;
  }

  listPermissions(): Promise<Permission[]> {
    return this.roleRepo.listPermissions();
  }

  // ── Role management ──────────────────────────────────────────────────────────

  async createRole(input: CreateRoleInput, actor: Actor): Promise<RoleWithPermissions> {
    if (await this.roleRepo.findByKey(input.key)) {
      throw new ConflictException('ROLE_KEY_TAKEN', `Role key '${input.key}' already exists`);
    }
    await this.assertPermissionsExist(input.permissions);
    return this.db.transaction(async (tx) => {
      const role = await this.roleRepo.create(input, tx);
      await this.roleTrail.record(AUDIT_ACTION.ROLE_CREATED, role.id, actor, tx, {
        after: { key: role.key, permissions: role.permissions },
      });
      return role;
    });
  }

  async setRolePermissions(
    roleId: string,
    permissionKeys: string[],
    actor: Actor,
  ): Promise<RoleWithPermissions> {
    const role = await this.getRole(roleId);
    await this.assertPermissionsExist(permissionKeys);
    await this.db.transaction(async (tx) => {
      await this.roleRepo.setPermissions(roleId, permissionKeys, tx);
      await this.roleTrail.record(AUDIT_ACTION.ROLE_PERMISSIONS_UPDATED, roleId, actor, tx, {
        before: { permissions: role.permissions },
        after: { permissions: permissionKeys },
      });
    });
    // Editing a role changes what every HOLDER can do, so their cached resolutions
    // are stale the moment this commits. This used to rely on the 300s cache TTL —
    // documented, but it meant REMOVING a permission from a role took up to five
    // minutes to take effect while every other write path here was immediate. Two
    // revocation latencies in one service is the inconsistency, and the slow one is
    // the security-relevant direction.
    //
    // Role KEYS are unchanged by this operation, so `employees.roles` (the claims
    // cache) needs no re-sync — only the permission cache does.
    await this.invalidateRoleHolders(roleId);
    return this.getRole(roleId);
  }

  async deleteRole(roleId: string, actor: Actor): Promise<void> {
    const role = await this.getRole(roleId);
    if (role.system) {
      throw new ValidationException(
        'ROLE_IMMUTABLE',
        `System role '${role.key}' cannot be deleted`,
      );
    }
    // Read holders BEFORE the delete: `user_role_assignments.role_id` is
    // ON DELETE CASCADE, so afterwards there is nothing left to enumerate.
    const holders = await this.assignmentRepo.listUserIdsForRole(roleId);

    await this.db.transaction(async (tx) => {
      await this.roleRepo.delete(roleId, tx);
      // The entry is the only remaining record of the role and of how many people held it.
      await this.roleTrail.record(AUDIT_ACTION.ROLE_DELETED, roleId, actor, tx, {
        before: { key: role.key, permissions: role.permissions, holders: holders.length },
      });
    });

    // Both caches are now wrong for every holder: the permission cache still grants
    // the deleted role's codes, and `employees.roles` still lists its key.
    for (const userId of holders) {
      await this.assignmentRepo.syncEmployeeRoleClaims(userId);
      await this.authz.invalidate(userId);
    }
  }

  /**
   * Drop the cached permission resolution of everyone holding `roleId`.
   *
   * Sequential rather than parallel on purpose: the holder count is bounded by the
   * org's headcount, and a burst of concurrent Valkey deletes on a role held by
   * everyone is a worse failure mode than taking a few more milliseconds.
   */
  private async invalidateRoleHolders(roleId: string): Promise<void> {
    const holders = await this.assignmentRepo.listUserIdsForRole(roleId);
    for (const userId of holders) {
      await this.authz.invalidate(userId);
    }
  }

  // ── Assignments ──────────────────────────────────────────────────────────────

  listUserAssignments(userId: string): Promise<RoleAssignment[]> {
    return this.assignmentRepo.listForUser(userId);
  }

  async assignRole(command: AssignRoleCommand, actor: Actor): Promise<RoleAssignment> {
    const role = await this.roleRepo.findById(command.roleId);
    if (!role) throw new NotFoundException('ROLE_NOT_FOUND', `Role ${command.roleId} not found`);

    // Privilege-escalation guard (NIST AC-6 least privilege): an actor may only
    // grant a role whose permission set is a subset of their own. This prevents,
    // e.g., an HR/role.assign holder from granting themselves or others the
    // `admin` (`*`) role. Holders of `*` (platform admins) can grant anything.
    await this.assertCanGrantRole(actor, role);

    const scopeType = command.scopeType ?? 'global';
    const scopeId =
      scopeType === 'global' || scopeType === 'self' ? null : (command.scopeId ?? null);
    if (scopeType !== 'global' && scopeType !== 'self' && !scopeId) {
      throw new ValidationException(
        'VALIDATION_FAILED',
        `scopeId is required for scope type '${scopeType}'`,
      );
    }

    // `team` and `region` are in the scope_type enum and the ScopeEvaluator, but
    // NOTHING in the schema produces a team or a region: there is no teams table and
    // no region column, so `ResourceScopeResolver` can never populate those
    // attributes and a grant scoped to them can only ever deny.
    //
    // Refusing at write time is the honest failure. Accepting the grant would let an
    // operator believe they had scoped someone's access when they had actually
    // removed it — and before the guard started failing closed, it silently GRANTED
    // everything instead, which is worse. Re-allow a dimension here in the same
    // change that gives the schema and the resolver something to match on.
    if (scopeType === 'team' || scopeType === 'region') {
      throw new ValidationException(
        'VALIDATION_FAILED',
        `Scope type '${scopeType}' is not supported yet: no resource carries a ` +
          `${scopeType}, so the grant could never be satisfied. Use 'global', 'self' ` +
          `or 'dept'.`,
      );
    }

    const assignment = await this.db.transaction(async (tx) => {
      const created = await this.assignmentRepo.assign(
        {
          userId: command.userId,
          roleId: command.roleId,
          scopeType,
          scopeId,
          grantedBy: actor.sub,
          expiresAt: command.expiresAt ?? null,
        },
        tx,
      );
      // The grant and the record of who made it commit together — the pair an access review reads.
      await this.assignmentTrail.record(AUDIT_ACTION.ROLE_ASSIGNED, created.id, actor, tx, {
        after: {
          userId: command.userId,
          roleKey: role.key,
          scopeType,
          scopeId,
          expiresAt: created.expiresAt?.toISOString() ?? null,
        },
      });
      return created;
    });

    // Keep the JWT roles[] claim cache in sync with the RBAC source of truth, then bust the permission
    // cache so enforcement is immediate. After the commit: neither is transactional.
    await this.assignmentRepo.syncEmployeeRoleClaims(command.userId);
    await this.authz.invalidate(command.userId);
    return assignment;
  }

  /**
   * Reconcile a user's GLOBAL role assignments to exactly match `roleKeys`
   * (grant missing, revoke extra), then refresh the JWT claim cache and
   * permission cache. This is the single mechanism by which external identity
   * providers (Entra App Roles) become OpsHub permissions — the assignments
   * table stays the source of truth, and `employees.roles` is derived from it.
   *
   * Unknown role keys are ignored (fail-safe: an unmapped Entra role never
   * grants access). Scoped (non-global) assignments are left untouched.
   *
   * `fallbackKey` is what the person holds when NONE of `roleKeys` names a role that exists (an empty claim, or
   * only roles opshub has never heard of). It is a floor, never an addition: it applies only when the
   * reconciliation would otherwise leave them with no global role at all, and it can never exceed what the
   * caller names. The sign-in passes `employee`, the role with no permissions of its own.
   * This bypasses the interactive escalation guard by design: it runs as the
   * system during SSO provisioning, mirroring what the IdP already asserts.
   */
  async syncUserRolesByKeys(
    userId: string,
    roleKeys: string[],
    actor: Actor,
    fallbackKey?: string,
  ): Promise<string[]> {
    const allRoles = await this.roleRepo.list();
    const idByKey = new Map(allRoles.map((r) => [r.key, r.id]));
    const keyById = new Map(allRoles.map((r) => [r.id, r.key]));

    const desiredRoleIds = new Set(
      roleKeys.map((k) => idByKey.get(k)).filter((id): id is string => !!id),
    );
    if (desiredRoleIds.size === 0 && fallbackKey) {
      const fallbackId = idByKey.get(fallbackKey);
      if (fallbackId) desiredRoleIds.add(fallbackId);
    }

    const current = await this.assignmentRepo.listForUser(userId);
    const currentGlobal = current.filter((a) => a.scopeType === 'global');
    const currentRoleIds = new Set(currentGlobal.map((a) => a.roleId));

    const granted = [...desiredRoleIds].map((id) => keyById.get(id)).filter(Boolean);

    // ONE transaction for the whole reconciliation and its entry: an SSO login that granted three roles and
    // revoked one is a single event, and a partially applied one would misrepresent what the IdP asserted.
    await this.db.transaction(async (tx) => {
      for (const roleId of desiredRoleIds) {
        if (!currentRoleIds.has(roleId)) {
          await this.assignmentRepo.assign(
            {
              userId,
              roleId,
              scopeType: 'global',
              scopeId: null,
              grantedBy: actor.sub,
              expiresAt: null,
            },
            tx,
          );
        }
      }
      for (const a of currentGlobal) {
        if (!desiredRoleIds.has(a.roleId)) {
          await this.assignmentRepo.revoke(a.id, tx);
        }
      }
      await this.employeeTrail.record(AUDIT_ACTION.ROLE_SYNCED, userId, actor, tx, {
        before: { roleIds: [...currentRoleIds] },
        after: { requestedKeys: roleKeys, appliedRoles: granted },
      });
    });

    const finalKeys = await this.assignmentRepo.syncEmployeeRoleClaims(userId);
    await this.authz.invalidate(userId);
    return finalKeys;
  }

  async revokeAssignment(id: string, actor: Actor): Promise<void> {
    const assignment = await this.assignmentRepo.findById(id);
    if (!assignment) {
      throw new NotFoundException('ROLE_ASSIGNMENT_NOT_FOUND', `Assignment ${id} not found`);
    }
    await this.db.transaction(async (tx) => {
      await this.assignmentRepo.revoke(id, tx);
      await this.assignmentTrail.record(AUDIT_ACTION.ROLE_REVOKED, id, actor, tx, {
        before: { userId: assignment.userId, roleId: assignment.roleId },
      });
    });

    await this.assignmentRepo.syncEmployeeRoleClaims(assignment.userId);
    await this.authz.invalidate(assignment.userId);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  /**
   * Enforce no-privilege-escalation: the actor must already hold every
   * permission carried by the role they are granting. Platform admins (holders
   * of the `*` wildcard) can grant any role. Fails closed.
   */
  private async assertCanGrantRole(actor: Actor, role: RoleWithPermissions): Promise<void> {
    const effective = await this.authz.resolve(actor.sub);
    const actorPerms = new Set(Object.keys(effective));
    if (actorPerms.has('*')) return; // platform admin — may grant anything

    // Granting a role that itself carries `*` requires the actor to be `*`.
    const missing = role.permissions.filter((p) => !actorPerms.has(p));
    if (missing.length > 0) {
      throw new PermissionDeniedException(
        `Cannot grant role '${role.key}': it includes permissions you do not hold (${missing.join(', ')}).`,
      );
    }
  }

  private async assertPermissionsExist(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const catalog = new Set((await this.roleRepo.listPermissions()).map((p) => p.key));
    const unknown = keys.filter((k) => !catalog.has(k));
    if (unknown.length > 0) {
      throw new ValidationException(
        'PERMISSION_NOT_FOUND',
        `Unknown permission keys: ${unknown.join(', ')}`,
      );
    }
  }
}
