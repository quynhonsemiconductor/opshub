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
import type {
  EmployeePermission,
  Permission,
  EmployeeGroup,
  GroupWithPermissions,
  ScopeType,
} from '@platform';
import { eq } from 'drizzle-orm';
import { employees } from '../../../../../db/schema';
import {
  AuditService,
  AUDIT_ACTION,
  AUDIT_RESOURCE,
  type ResourceAuditTrail,
} from '@modules/audit';
import {
  GROUP_REPOSITORY,
  type CreateGroupInput,
  type IGroupRepository,
} from '../domain/ports/group.repository';
import {
  EMPLOYEE_GROUP_REPOSITORY,
  type IEmployeeGroupRepository,
} from '../domain/ports/employee-group.repository';
import {
  EMPLOYEE_PERMISSION_REPOSITORY,
  type IEmployeePermissionRepository,
} from '../domain/ports/employee-permission.repository';
import { resolveGrantScope } from './grant-scope.helper';
import { mayGrantPermission } from './permission-grant.helper';

export interface Actor {
  sub: string;
  email: string;
}

export interface AssignGroupCommand {
  employeeId: string;
  groupId: string;
  scopeType?: ScopeType;
  scopeId?: string | null;
  expiresAt?: Date | null;
}

export interface GrantEmployeePermissionCommand {
  employeeId: string;
  permissionKey: string;
  scopeType?: ScopeType;
  scopeId?: string | null;
  /** Why the employee holds this permission outside a group. */
  reason: string;
  expiresAt?: Date | null;
}

/**
 * Administrative RBAC operations: manage groups and their permissions, put employees in groups (scoped) and remove them, and grant permissions to
 * one employee directly.
 *
 * THE AUDIT ENTRY SHARES THE MUTATION'S TRANSACTION. These were fire-and-forget, and of everything in this
 * codebase these are the writes least able to afford it: who granted which group to whom, and who deleted a
 * group, is the first question any access review asks. A grant that committed while its entry was lost left no
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
  private readonly groupTrail: ResourceAuditTrail;
  private readonly employeeGroupTrail: ResourceAuditTrail;
  private readonly employeeTrail: ResourceAuditTrail;
  private readonly employeePermissionTrail: ResourceAuditTrail;

  constructor(
    @Inject(GROUP_REPOSITORY) private readonly groupRepo: IGroupRepository,
    @Inject(EMPLOYEE_GROUP_REPOSITORY)
    private readonly employeeGroupRepo: IEmployeeGroupRepository,
    @Inject(EMPLOYEE_PERMISSION_REPOSITORY)
    private readonly employeePermissionRepo: IEmployeePermissionRepository,
    private readonly authz: AuthzService,
    @InjectDrizzle() private readonly db: DrizzleDB,
    audit: AuditService,
  ) {
    this.groupTrail = audit.forResource(AUDIT_RESOURCE.GROUP);
    this.employeeGroupTrail = audit.forResource(AUDIT_RESOURCE.EMPLOYEE_GROUP);
    this.employeeTrail = audit.forResource(AUDIT_RESOURCE.EMPLOYEE);
    this.employeePermissionTrail = audit.forResource(AUDIT_RESOURCE.EMPLOYEE_PERMISSION);
  }

  // ── Catalog ────────────────────────────────────────────────────────────────

  listGroups(): Promise<GroupWithPermissions[]> {
    return this.groupRepo.list();
  }

  async getGroup(id: string): Promise<GroupWithPermissions> {
    const group = await this.groupRepo.findById(id);
    if (!group) throw new NotFoundException('GROUP_NOT_FOUND', `Group ${id} not found`);
    return group;
  }

  listPermissions(): Promise<Permission[]> {
    return this.groupRepo.listPermissions();
  }

  // ── Group management ──────────────────────────────────────────────────────────

  async createGroup(input: CreateGroupInput, actor: Actor): Promise<GroupWithPermissions> {
    if (await this.groupRepo.findByKey(input.key)) {
      throw new ConflictException('GROUP_KEY_TAKEN', `Group key '${input.key}' already exists`);
    }
    await this.assertPermissionsExist(input.permissions);
    return this.db.transaction(async (tx) => {
      const group = await this.groupRepo.create(input, tx);
      await this.groupTrail.record(AUDIT_ACTION.GROUP_CREATED, group.id, actor, tx, {
        after: { key: group.key, permissions: group.permissions },
      });
      return group;
    });
  }

  async setGroupPermissions(
    groupId: string,
    permissionKeys: string[],
    actor: Actor,
  ): Promise<GroupWithPermissions> {
    const group = await this.getGroup(groupId);
    await this.assertPermissionsExist(permissionKeys);
    await this.db.transaction(async (tx) => {
      await this.groupRepo.setPermissions(groupId, permissionKeys, tx);
      await this.groupTrail.record(AUDIT_ACTION.GROUP_PERMISSIONS_UPDATED, groupId, actor, tx, {
        before: { permissions: group.permissions },
        after: { permissions: permissionKeys },
      });
    });
    // Editing a group changes what every HOLDER can do, so their cached resolutions
    // are stale the moment this commits. This used to rely on the 300s cache TTL —
    // documented, but it meant REMOVING a permission from a group took up to five
    // minutes to take effect while every other write path here was immediate. Two
    // revocation latencies in one service is the inconsistency, and the slow one is
    // the security-relevant direction.
    //
    // Group KEYS are unchanged by this operation, so `employees.groups` (the claims
    // cache) needs no re-sync — only the permission cache does.
    await this.invalidateGroupMembers(groupId);
    return this.getGroup(groupId);
  }

  async deleteGroup(groupId: string, actor: Actor): Promise<void> {
    const group = await this.getGroup(groupId);
    if (group.system) {
      throw new ValidationException(
        'GROUP_IMMUTABLE',
        `System group '${group.key}' cannot be deleted`,
      );
    }
    // Read holders BEFORE the delete: `employee_groups.group_id` is
    // ON DELETE CASCADE, so afterwards there is nothing left to enumerate.
    const holders = await this.employeeGroupRepo.listEmployeeIdsForGroup(groupId);

    await this.db.transaction(async (tx) => {
      await this.groupRepo.delete(groupId, tx);
      // The entry is the only remaining record of the group and of how many people held it.
      await this.groupTrail.record(AUDIT_ACTION.GROUP_DELETED, groupId, actor, tx, {
        before: { key: group.key, permissions: group.permissions, holders: holders.length },
      });
    });

    // Both caches are now wrong for every holder: the permission cache still grants
    // the deleted group's codes, and `employees.groups` still lists its key.
    for (const employeeId of holders) {
      await this.employeeGroupRepo.syncEmployeeGroupKeys(employeeId);
      await this.authz.invalidate(employeeId);
    }
  }

  /**
   * Drop the cached permission resolution of everyone holding `groupId`.
   *
   * Sequential rather than parallel on purpose: the holder count is bounded by the
   * org's headcount, and a burst of concurrent Valkey deletes on a group held by
   * everyone is a worse failure mode than taking a few more milliseconds.
   */
  private async invalidateGroupMembers(groupId: string): Promise<void> {
    const holders = await this.employeeGroupRepo.listEmployeeIdsForGroup(groupId);
    for (const employeeId of holders) {
      await this.authz.invalidate(employeeId);
    }
  }

  // ── Assignments ──────────────────────────────────────────────────────────────

  listEmployeeGroups(employeeId: string): Promise<EmployeeGroup[]> {
    return this.employeeGroupRepo.listForEmployee(employeeId);
  }

  async assignGroup(command: AssignGroupCommand, actor: Actor): Promise<EmployeeGroup> {
    const group = await this.groupRepo.findById(command.groupId);
    if (!group)
      throw new NotFoundException('GROUP_NOT_FOUND', `Group ${command.groupId} not found`);

    // Privilege-escalation guard (NIST AC-6 least privilege): an actor may only
    // grant a group whose permission set is a subset of their own. This prevents,
    // e.g., an HR/group.assign holder from granting themselves or others the
    // `admin` (`*`) group. Holders of `*` (platform admins) can grant anything.
    await this.assertCanGrantGroup(actor, group);

    const { scopeType, scopeId } = resolveGrantScope(command.scopeType, command.scopeId);

    const assignment = await this.db.transaction(async (tx) => {
      const created = await this.employeeGroupRepo.assign(
        {
          employeeId: command.employeeId,
          groupId: command.groupId,
          scopeType,
          scopeId,
          grantedBy: actor.sub,
          expiresAt: command.expiresAt ?? null,
        },
        tx,
      );
      // The grant and the record of who made it commit together — the pair an access review reads.
      await this.employeeGroupTrail.record(AUDIT_ACTION.GROUP_ASSIGNED, created.id, actor, tx, {
        after: {
          employeeId: command.employeeId,
          groupKey: group.key,
          scopeType,
          scopeId,
          expiresAt: created.expiresAt?.toISOString() ?? null,
        },
      });
      return created;
    });

    // Keep the JWT groups[] claim cache in sync with the RBAC source of truth, then bust the permission
    // cache so enforcement is immediate. After the commit: neither is transactional.
    await this.employeeGroupRepo.syncEmployeeGroupKeys(command.employeeId);
    await this.authz.invalidate(command.employeeId);
    return assignment;
  }

  /**
   * Reconcile an employee's GLOBAL group memberships to exactly match `groupKeys`
   * (grant missing, revoke extra), then refresh the JWT claim cache and
   * permission cache. This is the single mechanism by which external identity
   * providers (Entra App Roles) become OpsHub permissions — the assignments
   * table stays the source of truth, and `employees.groups` is derived from it.
   *
   * Unknown group keys are ignored (fail-safe: an unmapped Entra App Role never
   * grants access). Scoped (non-global) assignments are left untouched.
   *
   * `fallbackKey` is what the person holds when NONE of `groupKeys` names a group that exists (an empty claim, or
   * only groups opshub has never heard of). It is a floor, never an addition: it applies only when the
   * reconciliation would otherwise leave them with no global group at all, and it can never exceed what the
   * caller names. The sign-in passes `employee`, the group with no permissions of its own.
   * This bypasses the interactive escalation guard by design: it runs as the
   * system during SSO provisioning, mirroring what the IdP already asserts.
   */
  async syncEmployeeGroupsByKeys(
    employeeId: string,
    groupKeys: string[],
    actor: Actor,
    fallbackKey?: string,
  ): Promise<string[]> {
    const allGroups = await this.groupRepo.list();
    const idByKey = new Map(allGroups.map((r) => [r.key, r.id]));
    const keyById = new Map(allGroups.map((r) => [r.id, r.key]));

    const desiredGroupIds = new Set(
      groupKeys.map((k) => idByKey.get(k)).filter((id): id is string => !!id),
    );
    if (desiredGroupIds.size === 0 && fallbackKey) {
      const fallbackId = idByKey.get(fallbackKey);
      if (fallbackId) desiredGroupIds.add(fallbackId);
    }

    const current = await this.employeeGroupRepo.listForEmployee(employeeId);
    const currentGlobal = current.filter((a) => a.scopeType === 'global');
    const currentGroupIds = new Set(currentGlobal.map((a) => a.groupId));

    const granted = [...desiredGroupIds].map((id) => keyById.get(id)).filter(Boolean);

    // ONE transaction for the whole reconciliation and its entry: an SSO login that granted three groups and
    // revoked one is a single event, and a partially applied one would misrepresent what the IdP asserted.
    await this.db.transaction(async (tx) => {
      for (const groupId of desiredGroupIds) {
        if (!currentGroupIds.has(groupId)) {
          await this.employeeGroupRepo.assign(
            {
              employeeId,
              groupId,
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
        if (!desiredGroupIds.has(a.groupId)) {
          await this.employeeGroupRepo.revoke(a.id, tx);
        }
      }
      await this.employeeTrail.record(AUDIT_ACTION.GROUP_SYNCED, employeeId, actor, tx, {
        before: { groupIds: [...currentGroupIds] },
        after: { requestedKeys: groupKeys, appliedGroups: granted },
      });
    });

    const finalKeys = await this.employeeGroupRepo.syncEmployeeGroupKeys(employeeId);
    await this.authz.invalidate(employeeId);
    return finalKeys;
  }

  // ── Direct employee permissions ──────────────────────────────────────────────

  /**
   * Lists the permissions granted straight to an employee, outside any group.
   *
   * Args:
   *   employeeId: The employee whose direct grants are wanted.
   *
   * Returns:
   *   Every direct grant, newest first, expired ones included so a review can see them.
   */
  listEmployeePermissions(employeeId: string): Promise<EmployeePermission[]> {
    return this.employeePermissionRepo.listForEmployee(employeeId);
  }

  /**
   * Grants one permission straight to an employee, outside any group.
   *
   * The grant and its audit entry commit together. The employee's cached permissions are dropped after the
   * commit, so enforcement is immediate.
   *
   * Args:
   *   command: The employee, the permission, an optional scope and expiry, and the mandatory reason.
   *   actor: Who is granting; they must themselves hold the permission globally (see `mayGrantPermission`).
   *
   * Returns:
   *   The stored grant; the existing one when the same permission and scope were already granted.
   *
   * Raises:
   *   NotFoundException: If the employee does not exist.
   *   ValidationException: If the permission is unknown, the scope is invalid or the expiry is in the past.
   *   PermissionDeniedException: If the actor does not hold the permission they are trying to grant.
   */
  async grantEmployeePermission(
    command: GrantEmployeePermissionCommand,
    actor: Actor,
  ): Promise<EmployeePermission> {
    const [employee] = await this.db
      .select({ id: employees.id })
      .from(employees)
      .where(eq(employees.id, command.employeeId))
      .limit(1);
    if (!employee) {
      throw new NotFoundException('EMPLOYEE_NOT_FOUND', `Employee ${command.employeeId} not found`);
    }

    await this.assertPermissionsExist([command.permissionKey]);
    await this.assertCanGrantPermission(actor, command.permissionKey);
    const { scopeType, scopeId } = resolveGrantScope(command.scopeType, command.scopeId);

    if (command.expiresAt && command.expiresAt.getTime() <= Date.now()) {
      throw new ValidationException('VALIDATION_FAILED', 'expiresAt must be in the future');
    }

    const grant = await this.db.transaction(async (tx) => {
      const created = await this.employeePermissionRepo.grant(
        {
          employeeId: command.employeeId,
          permissionKey: command.permissionKey,
          scopeType,
          scopeId,
          grantedBy: actor.sub,
          reason: command.reason,
          expiresAt: command.expiresAt ?? null,
        },
        tx,
      );
      await this.employeePermissionTrail.record(
        AUDIT_ACTION.EMPLOYEE_PERMISSION_GRANTED,
        created.id,
        actor,
        tx,
        {
          after: {
            employeeId: command.employeeId,
            permissionKey: command.permissionKey,
            scopeType,
            scopeId,
            reason: command.reason,
            expiresAt: created.expiresAt?.toISOString() ?? null,
          },
        },
      );
      return created;
    });

    await this.authz.invalidate(command.employeeId);
    return grant;
  }

  /**
   * Revokes a permission that was granted straight to an employee.
   *
   * Args:
   *   id: The direct grant to remove.
   *   actor: Who is revoking.
   *
   * Raises:
   *   NotFoundException: If the grant does not exist.
   */
  async revokeEmployeePermission(id: string, actor: Actor): Promise<void> {
    const grant = await this.employeePermissionRepo.findById(id);
    if (!grant) {
      throw new NotFoundException('EMPLOYEE_PERMISSION_NOT_FOUND', `Grant ${id} not found`);
    }
    await this.db.transaction(async (tx) => {
      await this.employeePermissionRepo.revoke(id, tx);
      await this.employeePermissionTrail.record(
        AUDIT_ACTION.EMPLOYEE_PERMISSION_REVOKED,
        id,
        actor,
        tx,
        { before: { employeeId: grant.employeeId, permissionKey: grant.permissionKey } },
      );
    });
    await this.authz.invalidate(grant.employeeId);
  }

  async revokeEmployeeGroup(id: string, actor: Actor): Promise<void> {
    const assignment = await this.employeeGroupRepo.findById(id);
    if (!assignment) {
      throw new NotFoundException('EMPLOYEE_GROUP_NOT_FOUND', `Assignment ${id} not found`);
    }
    await this.db.transaction(async (tx) => {
      await this.employeeGroupRepo.revoke(id, tx);
      await this.employeeGroupTrail.record(AUDIT_ACTION.GROUP_REVOKED, id, actor, tx, {
        before: { employeeId: assignment.employeeId, groupId: assignment.groupId },
      });
    });

    await this.employeeGroupRepo.syncEmployeeGroupKeys(assignment.employeeId);
    await this.authz.invalidate(assignment.employeeId);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  /**
   * Enforce no-privilege-escalation: the actor must already hold every
   * permission carried by the group they are granting. Platform admins (holders
   * of the `*` wildcard) can grant any group. Fails closed.
   */
  private async assertCanGrantGroup(actor: Actor, group: GroupWithPermissions): Promise<void> {
    const effective = await this.authz.resolve(actor.sub);
    const actorPerms = new Set(Object.keys(effective));
    if (actorPerms.has('*')) return; // platform admin — may grant anything

    // Granting a group that itself carries `*` requires the actor to be `*`.
    const missing = group.permissions.filter((p) => !actorPerms.has(p));
    if (missing.length > 0) {
      throw new PermissionDeniedException(
        `Cannot grant group '${group.key}': it includes permissions you do not hold (${missing.join(', ')}).`,
      );
    }
  }

  /**
   * Enforces no-privilege-escalation for a direct grant: the actor must hold the permission globally.
   * Fails closed.
   */
  private async assertCanGrantPermission(actor: Actor, permissionKey: string): Promise<void> {
    const grantorPermissions = await this.authz.resolve(actor.sub);
    if (!mayGrantPermission(grantorPermissions, permissionKey)) {
      throw new PermissionDeniedException(
        `Cannot grant '${permissionKey}': you do not hold it without a scope limit.`,
      );
    }
  }

  private async assertPermissionsExist(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const catalog = new Set((await this.groupRepo.listPermissions()).map((p) => p.key));
    const unknown = keys.filter((k) => !catalog.has(k));
    if (unknown.length > 0) {
      throw new ValidationException(
        'PERMISSION_NOT_FOUND',
        `Unknown permission keys: ${unknown.join(', ')}`,
      );
    }
  }
}
