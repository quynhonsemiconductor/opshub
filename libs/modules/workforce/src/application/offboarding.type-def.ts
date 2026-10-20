import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import {
  AuthzService,
  type DbExecutor,
  InjectDrizzle,
  type DrizzleDB,
  RequestRegistry,
  RequestTypeDef,
  SESSION_REVOKER,
  type SessionRevoker,
} from '@platform';
import { AUDIT_ACTION, AUDIT_RESOURCE, AuditService } from '@modules/audit';
import { GRAPH_TASK, GraphTaskQueue } from '@modules/graph';
import { REQUEST_TYPE } from '@shared-kernel';
import {
  employees,
  userRoleAssignments,
  accessGrants,
  assetAssignments,
  assets,
  session as identitySession,
  user as identityUser,
} from '../../../../../db/schema';

export interface OffboardingPayload extends Record<string, unknown> {
  /** The employee being offboarded. */
  employeeId: string;
  employeeEmail: string;
  reason?: string;
}

/**
 * Single-step offboarding workflow (HR approves).
 *
 * `onApprove` atomically:
 *   1. Sets employee status → `offboarded`
 *   2. Removes all RBAC role assignments, and clears the cached role claims with them
 *   3. Revokes all active access grants
 *   4. Returns all assigned hardware assets (sets returnedAt, status → in_stock)
 *   5. Blocks the employee from signing in (identity user `banned`) and deletes every session row
 *      (forces immediate logout); `afterApprove` then clears the cached sessions in Valkey
 *
 * All five operations share the same transaction, so either all succeed or none do.
 *
 * EVERY REMOVAL IS AUDITED, AND THAT WAS THE DEFECT. This hook wrote all five steps and recorded
 * NOTHING — no `role.revoked`, no `access_grant.revoked`, no `asset.unassigned` — because it writes
 * the tables directly instead of going through the services that own them, and those services are
 * where the audit calls live. Every one of those events is audited when a person does it by hand, so
 * an access-removal review saw a leaver whose privileges vanished with no record of who took them or
 * when. That is precisely the evidence ISO 27001 A.8 asks for, on the one path that most needs it.
 *
 * The entries use the SAME action codes and resource types the owning services use, so the trail
 * reads identically whether access was removed one row at a time or by this workflow.
 *
 * STILL A LAYER VIOLATION: the writes belong to `AuthzAdminService`, `AssetService`,
 * `AccessRequestService` and the identity session store, and each of those exposes only a
 * transaction-OWNING method, which cannot be called from inside the engine's `tx` without nesting.
 * The fix is a `tx`-accepting method on each, the way `RiskAcceptanceTypeDef` calls
 * `RisksService.applyAcceptance(..., tx)`. That is a wider change than the missing evidence, so it is
 * left for its own commit; this one closes the audit and cache holes.
 */
@Injectable()
export class OffboardingTypeDef implements RequestTypeDef<OffboardingPayload>, OnModuleInit {
  private readonly logger = new Logger(OffboardingTypeDef.name);

  readonly type = REQUEST_TYPE.OFFBOARDING;
  readonly requiredApprovalPermission = 'offboarding.approve';
  readonly allowSelfApproval = false;
  readonly defaultExpiryHours = 72; // 3 days
  readonly slaHours = 24; // same-day SLA for security

  private readonly employeeTrail;
  private readonly roleAssignmentTrail;
  private readonly grantTrail;
  private readonly assetTrail;
  private readonly sessionTrail;

  constructor(
    private readonly registry: RequestRegistry,
    @InjectDrizzle() private readonly db: DrizzleDB,
    private readonly graphTasks: GraphTaskQueue,
    private readonly authz: AuthzService,
    audit: AuditService,
    /**
     * Bound by the API's AuthModule; ABSENT in the worker, which can compile this module but never approves an
     * offboarding. Injected optionally so that compiling it there does not fail, and REQUIRED where it is used:
     * `revoker()` throws, like `EmployeeService`, instead of skipping the cache clear and leaving a leaver's
     * cached session behind.
     */
    @Optional() @Inject(SESSION_REVOKER) private readonly sessions?: SessionRevoker,
  ) {
    // One trail per resource the workflow touches, bound once — the same shape the owning services
    // use, so the entries this hook writes are indistinguishable from the ones they write.
    this.employeeTrail = audit.forResource(AUDIT_RESOURCE.EMPLOYEE);
    this.roleAssignmentTrail = audit.forResource(AUDIT_RESOURCE.ROLE_ASSIGNMENT);
    this.grantTrail = audit.forResource(AUDIT_RESOURCE.ACCESS_GRANT);
    this.assetTrail = audit.forResource(AUDIT_RESOURCE.ASSET);
    this.sessionTrail = audit.forResource(AUDIT_RESOURCE.SESSION);
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  /** The port is bound in the API only; approving an offboarding anywhere else is a wiring error, not a no-op. */
  private revoker(): SessionRevoker {
    if (!this.sessions) {
      throw new Error(
        'OffboardingTypeDef needs a SessionRevoker: bind it in the API (AuthModule).',
      );
    }
    return this.sessions;
  }

  async onApprove(
    payload: OffboardingPayload,
    _requestId: string,
    approverId: string,
    tx: DbExecutor,
  ): Promise<void> {
    // Refuse BEFORE changing anything where no revoker is bound: the cache clear after the commit is not optional.
    this.revoker();
    const now = new Date();
    const { employeeId } = payload;
    // The APPROVER is the actor on every entry below: they authorised the removal. The engine hands
    // this hook an id and no email, and both fields are recorded — so the id is carried in both,
    // visibly derived rather than silently blank. Same reasoning as `RiskAcceptanceTypeDef`.
    const actor = { sub: approverId, email: approverId };

    // 1. Mark employee as offboarded
    await tx
      .update(employees)
      .set({ status: 'offboarded', updatedAt: now })
      .where(eq(employees.id, employeeId));
    await this.employeeTrail.record(AUDIT_ACTION.EMPLOYEE_STATUS_CHANGED, employeeId, actor, tx, {
      after: { status: 'offboarded', reason: payload.reason ?? null },
    });

    /*
     * 2. Remove all RBAC role assignments.
     *
     * `returning()` so each removal can be recorded individually. One entry per assignment, not one
     * summarising them: an access review asks "when did this person lose THIS role", and a single
     * row saying "5 roles removed" cannot answer it.
     */
    const removedRoles = await tx
      .delete(userRoleAssignments)
      .where(eq(userRoleAssignments.userId, employeeId))
      .returning({ id: userRoleAssignments.id, roleId: userRoleAssignments.roleId });

    for (const assignment of removedRoles) {
      await this.roleAssignmentTrail.record(AUDIT_ACTION.ROLE_REVOKED, assignment.id, actor, tx, {
        before: { userId: employeeId, roleId: assignment.roleId },
      });
    }

    /*
     * The cached role claims go with them, IN THIS TRANSACTION.
     *
     * `employees.roles` is a denormalised copy of the active assignments that feeds the JWT claims,
     * and nothing here maintained it — so an offboarded employee's row still listed `it-admin` after
     * every assignment behind it was gone. `AuthzAdminService` keeps it in step by calling
     * `syncEmployeeRoleClaims` after its own transaction; here the answer is known without a query,
     * because step 2 removed ALL of them, and setting it inside the transaction means the copy can
     * never disagree with the rows it copies.
     */
    await tx
      .update(employees)
      .set({ roles: [], updatedAt: now })
      .where(eq(employees.id, employeeId));

    // 3. Revoke all active access grants
    const revokedGrants = await tx
      .update(accessGrants)
      .set({ revokedAt: now })
      .where(and(eq(accessGrants.granteeId, employeeId), isNull(accessGrants.revokedAt)))
      .returning({
        id: accessGrants.id,
        accessType: accessGrants.accessType,
        target: accessGrants.target,
      });

    for (const grant of revokedGrants) {
      await this.grantTrail.record(AUDIT_ACTION.ACCESS_GRANT_REVOKED, grant.id, actor, tx, {
        before: { granteeId: employeeId, accessType: grant.accessType, target: grant.target },
        after: { revokedAt: now, reason: 'offboarding' },
      });
    }

    // 4. Return all active asset assignments + reset asset status to in_stock
    const activeAssignments = await tx
      .update(assetAssignments)
      .set({ returnedAt: now })
      .where(and(eq(assetAssignments.employeeId, employeeId), isNull(assetAssignments.returnedAt)))
      .returning({ assetId: assetAssignments.assetId });

    for (const { assetId } of activeAssignments) {
      await tx
        .update(assets)
        .set({ status: 'in_stock', updatedAt: now })
        .where(eq(assets.id, assetId));
      // Audited against the ASSET, the same resource `AssetService.unassign` uses — so "where has
      // this laptop been" reads the same whether it came back by hand or with a leaver.
      await this.assetTrail.record(AUDIT_ACTION.ASSET_UNASSIGNED, assetId, actor, tx, {
        before: { assignedTo: employeeId },
        after: { status: 'in_stock', reason: 'offboarding' },
      });
    }

    // 5. End the leaver's sessions. In the transaction, with everything else: the identity user is BANNED (a
    // banned user cannot sign in, and identity refuses a banned user's session whenever it is read) and every
    // session row is deleted. The cached copies in Valkey cannot be rolled back with these rows, so
    // `afterApprove` clears them once the transaction has committed.
    await tx
      .update(identityUser)
      .set({ banned: true, banReason: 'offboarded', updatedAt: now })
      .where(eq(identityUser.id, employeeId));
    const revokedSessions = await tx
      .delete(identitySession)
      .where(eq(identitySession.userId, employeeId))
      .returning({ id: identitySession.id });

    if (revokedSessions.length > 0) {
      /*
       * ONE entry for the set, unlike the roles above — deliberately. A session is not a thing
       * anybody reviews individually; the reviewable fact is "every session was ended at this
       * moment". `session.revoked` rather than `auth.logout`, because the holder did not do this.
       */
      await this.sessionTrail.record(AUDIT_ACTION.SESSION_REVOKED, employeeId, actor, tx, {
        after: { revokedSessions: revokedSessions.length, reason: 'offboarding' },
      });
    }

    /*
     * 6. Entra: queue an account reconcile — IN THIS TRANSACTION.
     *
     * The employee row was set to `offboarded` in step 1 of this same transaction, so the task commits
     * with the status it depends on (roll the approval back and neither exists). The worker reads that
     * status when it runs and, seeing `offboarded`, disables the account and revokes its sign-in
     * sessions — disabling stops NEW sign-ins, revoking ends the refresh tokens already issued.
     *
     * The task carries the employee id and nothing else, so the API cannot aim it at another account and
     * an older queued "enable" for this person, run later, still finds them offboarded.
     */
    await this.graphTasks.enqueue(
      { kind: GRAPH_TASK.ACCOUNT_RECONCILE, payload: { employeeId } },
      tx,
    );
  }

  async onReject(
    _payload: OffboardingPayload,
    _requestId: string,
    _approverId: string,
    _tx: DbExecutor,
  ): Promise<void> {
    // Nothing to undo — no domain state was changed on submit.
  }

  /**
   * Post-commit work: drop the cached permissions, and the sessions cached in Valkey.
   *
   * THE CACHE INVALIDATION IS THE SECURITY-CRITICAL HALF, and it was missing entirely.
   * `AuthzService` caches a principal's resolved permissions for `CACHE_TTL_SECONDS = 300`, and every
   * other privilege-removal path calls `invalidate` — `AuthzAdminService.revokeAssignment` does it on
   * the line after its transaction. This hook did not, so for up to five minutes after being
   * offboarded a leaver's requests were still authorised against the roles they no longer held. Their
   * session was revoked, but an access token already in hand keeps working until it expires.
   *
   * AFTER THE COMMIT, NOT INSIDE IT. Invalidating inside the transaction leaves a window in which a
   * concurrent request misses the cache, re-resolves from rows that have not yet committed, and caches
   * the OLD permissions again. Rova's `removeMember` records the same ordering rule.
   *
   * The Entra disable is not here any more: it is a task queued by `onApprove`, in the transaction.
   */
  async afterApprove(payload: OffboardingPayload): Promise<void> {
    await this.authz.invalidate(payload.employeeId);
    // The sessions cached in Valkey (the rows went with the transaction). Rejects while the cache is
    // unavailable, which fails the post-commit step loudly instead of leaving a leaver's cached session behind:
    // the ban is already committed, so they cannot sign in again either way. (The Entra account disable is
    // a task queued in the transaction by `onApprove`, step 6.)
    await this.revoker().offboard(payload.employeeId, 'offboarded');
  }
}
