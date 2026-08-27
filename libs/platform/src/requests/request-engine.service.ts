import { Injectable, Logger } from '@nestjs/common';
import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { MS_PER_HOUR, newId, type Actor, type RequestType } from '@shared-kernel';
import { InjectDrizzle, type DbExecutor, type DrizzleDB } from '../database/drizzle.provider';
import { AuthzService } from '../auth/authz.service';
import { ActorScope } from '../auth/actor-scope.service';
import {
  NotFoundException,
  PreconditionFailedException,
  PermissionDeniedException,
} from '../errors/exceptions';
import { ErrorCodes } from '../errors/error-codes';
import { WebhookEnqueueService } from '../webhooks/webhook-enqueue.service';
import { requestItems, requestApprovals, requestComments } from '../../../../db/schema';
import { RequestRegistry } from './request-registry';
import { nameOf, resolveEmployeeNames } from '../directory/employee-names';
import { DelegationService } from '../authz/delegation.service';
import { NotificationSchedulerService } from '../notifications/notification-scheduler.service';
import type { NotificationTemplateVars } from '../notifications/notification.templates';
import type {
  RequestFilters,
  RequestItem,
  RequestItemWithApprovals,
  RequestStatus,
  RequestComment,
  SubmitRequestOptions,
} from './request-engine.types';

/**
 * Universal request state machine. All request workflows (access, leave,
 * overtime, onboarding…) go through this service for state transitions.
 *
 * Responsibilities:
 *  - SoD enforcement (requester ≠ approver, configurable per type)
 *  - Permission check via AuthzService before any approval
 *  - Atomic transactions: state update + TypeDef hook + webhook fan-out
 *  - Unified inbox queries via `list()`
 *
 * TypeDef hooks are called INSIDE the transaction so domain side-effects
 * (e.g. creating access_grants, updating leave status) are atomic.
 */
@Injectable()
export class RequestEngine {
  /** Above this many approvers for one step, the fan-out is logged as a signal, never trimmed. */
  private static readonly WIDE_FANOUT_THRESHOLD = 15;
  private readonly logger = new Logger(RequestEngine.name);

  constructor(
    @InjectDrizzle() private readonly db: DrizzleDB,
    private readonly registry: RequestRegistry,
    private readonly authz: AuthzService,
    private readonly actorScope: ActorScope,
    private readonly delegation: DelegationService,
    private readonly notifScheduler: NotificationSchedulerService,
    private readonly webhookEnqueue: WebhookEnqueueService,
  ) {}

  // ── Submit ────────────────────────────────────────────────────────────────

  async submit(
    type: RequestType,
    payload: Record<string, unknown>,
    actor: Actor,
    opts?: SubmitRequestOptions,
  ): Promise<RequestItem> {
    const def = this.registry.get(type);

    const expiresAt =
      opts?.expiresAt ??
      (def.defaultExpiryHours ? new Date(Date.now() + def.defaultExpiryHours * MS_PER_HOUR) : null);

    // SLA deadline — stored for breach cron; separate from expiry
    const slaHours = def.slaHours ?? null;
    const slaDeadline = slaHours ? new Date(Date.now() + slaHours * MS_PER_HOUR) : null;

    // Multi-step chain metadata — stored immutably at submit time
    const totalSteps = def.approvalSteps ? def.approvalSteps.length : 1;

    const item = await this.db.transaction(async (tx) => {
      // Allow TypeDef to validate payload / check domain constraints
      if (def.onSubmit) {
        await def.onSubmit(payload, actor.sub, tx);
      }

      const [row] = await tx
        .insert(requestItems)
        .values({
          id: newId(),
          type,
          requesterId: actor.sub,
          assigneeId: opts?.assigneeId ?? null,
          status: 'pending',
          priority: opts?.priority ?? 'normal',
          payload,
          expiresAt,
          slaHours,
          slaDeadline,
          currentStep: 1,
          totalSteps,
        })
        .returning();

      const submitPayload = {
        requestId: row.id,
        type,
        requesterId: actor.sub,
        priority: row.priority,
      };
      await this.webhookEnqueue.fanout(tx, 'request.submitted', submitPayload);

      /*
       * TELL WHOEVER CAN DECIDE IT.
       *
       * This was `if (row.assigneeId)` and nothing else, and `assigneeId` is set by no production
       * path: no `RequestTypeDef` defines a `resolverFn`, and no caller of `submit` passes
       * `opts.assigneeId`. Measured on a seeded database: 71 request rows, one assignee, and that one
       * written by a test. So raising a request notified NOBODY, and an approver had to think to go
       * and look. `request.step_ready` has the same shape and had never been delivered once.
       *
       * Assigning a request to a person is a product decision nobody has made, and this does not make
       * it. It notifies the people who could already act: `RequestApprovalStep.resolverFn` documents
       * `null` as "any holder of requiredPermission can approve", so the approvers ARE whoever holds
       * the permission, and `decidableByPredicate` builds "My queue" from that same fact. Queue and
       * prompt therefore cannot disagree — which is why the queue stopped depending on `assigneeId`.
       *
       * An explicit assignee still wins: naming one is a decision, and fanning out past it would be
       * second-guessing the caller.
       */
      const firstStepPermission =
        def.approvalSteps?.[0]?.requiredPermission ?? def.requiredApprovalPermission;
      await this.notifyDecisionMakers(tx, {
        notificationType: 'request.submitted',
        requestId: row.id,
        assigneeId: row.assigneeId,
        requiredPermission: firstStepPermission,
        excludeUserId: actor.sub,
        actorId: actor.sub,
        idempotencyPrefix: `request_submitted:${row.id}`,
        vars: { requestType: type, requestId: row.id, requesterEmail: actor.email },
      });

      return row;
    });

    this.logger.log({ requestId: item.id, type }, 'Request submitted');
    return item;
  }

  // ── Approve ────────────────────────────────────────────────────────────────

  async approve(requestId: string, note: string | null, actor: Actor): Promise<RequestItem> {
    const request = await this.getOrFail(requestId);
    this.assertApprovable(request.status);

    const def = this.registry.get(request.type);

    // ── Multi-step: resolve which step we're on ──────────────────────────────
    const steps = def.approvalSteps;
    const currentStep = request.currentStep;
    const stepDef = steps?.find((s) => s.step === currentStep) ?? null;
    const requiredPermission = stepDef?.requiredPermission ?? def.requiredApprovalPermission;
    const maxStep = steps ? Math.max(...steps.map((s) => s.step)) : 1;
    const isFinalStep = !steps || currentStep >= maxStep;

    // ── Delegation check ─────────────────────────────────────────────────────
    const activeDelegation = await this.delegation.findActiveDelegationTo(actor.sub);
    const sodSubject = activeDelegation ? activeDelegation.fromUserId : actor.sub;

    if (!def.allowSelfApproval && request.requesterId === sodSubject) {
      throw new PermissionDeniedException(
        'Requester cannot approve their own request',
        // The CODE, not a prefix on the message. A client distinguishing this from a missing
        // permission is the difference between "ask a colleague" and "ask for access".
        ErrorCodes.REQUEST_SOD_VIOLATION,
      );
    }

    // Permission check: actor OR delegator (union semantics)
    const actorAllowed = await this.authz.check(actor.sub, requiredPermission);
    const delegatorAllowed = activeDelegation
      ? await this.authz.check(activeDelegation.fromUserId, requiredPermission)
      : false;
    if (!actorAllowed && !delegatorAllowed) {
      throw new PermissionDeniedException(
        `Missing permission for step ${currentStep}: ${requiredPermission}`,
      );
    }

    const now = new Date();
    const updated = await this.db.transaction(async (tx) => {
      const nextStep = currentStep + 1;
      const nextStepDef = steps?.find((s) => s.step === nextStep) ?? null;

      // Resolve the assignee for the next step (if defined)
      let nextAssigneeId: string | null = request.assigneeId;
      if (!isFinalStep && nextStepDef?.resolverFn) {
        nextAssigneeId = (await nextStepDef.resolverFn(request.payload, tx)) ?? request.assigneeId;
      }

      const newStatus: RequestStatus = isFinalStep ? 'approved' : 'in_review';

      const [row] = await tx
        .update(requestItems)
        .set({
          status: newStatus,
          currentStep: isFinalStep ? currentStep : nextStep,
          assigneeId: isFinalStep ? request.assigneeId : nextAssigneeId,
          resolvedAt: isFinalStep ? now : null,
          resolutionNote: isFinalStep ? note : null,
          updatedAt: now,
        })
        .where(eq(requestItems.id, requestId))
        .returning();

      await tx.insert(requestApprovals).values({
        id: newId(),
        requestId,
        step: currentStep,
        approverId: actor.sub,
        decision: 'approved',
        note,
        delegatedFromId: activeDelegation?.fromUserId ?? null,
      });

      if (isFinalStep) {
        // Final approval: call domain hook
        await def.onApprove(request.payload, requestId, actor.sub, tx);
        // Notify the requester their request has been approved.
        await this.notifScheduler.schedule(tx, {
          type: 'request.approved',
          vars: { requestType: request.type, requestId },
          recipientId: request.requesterId,
          actorId: actor.sub,
          resourceId: requestId,
          idempotencyKey: `request_approved:${requestId}`,
        });
      } else {
        // Intermediate approval: call optional step hook and notify next assignee
        if (def.onStepApproved) {
          await def.onStepApproved(
            request.payload,
            requestId,
            currentStep,
            nextStep,
            nextAssigneeId,
            actor.sub,
            tx,
          );
        }

        /*
         * Whoever can decide the NEXT step, for the same reason as at submit. `nextAssigneeId` comes
         * from a `resolverFn` no type defines, so this branch never ran: `request.step_ready` had zero
         * deliveries on a database with 71 requests. A half-approved request is the one most needing
         * attention, and it was the one nobody heard about.
         *
         * The requester is excluded, as at submit — separation of duties refuses their own approval,
         * so telling them it is ready to decide would be an invitation to a 403.
         */
        await this.notifyDecisionMakers(tx, {
          notificationType: 'request.step_ready',
          requestId,
          assigneeId: nextAssigneeId,
          requiredPermission: nextStepDef?.requiredPermission ?? def.requiredApprovalPermission,
          excludeUserId: request.requesterId,
          idempotencyPrefix: `step_ready:${requestId}:${nextStep}`,
          vars: {
            requestType: request.type,
            requestId,
            completedStep: currentStep,
            nextStep,
            totalSteps: maxStep,
          },
        });
      }

      const approvalEventType = isFinalStep ? 'request.approved' : 'request.step_approved';
      const approvalPayload = {
        requestId,
        type: request.type,
        approverId: actor.sub,
        step: currentStep,
        isFinalStep,
        totalSteps: maxStep,
      };
      await this.webhookEnqueue.fanout(tx, approvalEventType, approvalPayload);

      return row;
    });

    this.logger.log(
      { requestId, type: request.type, step: currentStep, isFinalStep },
      isFinalStep ? 'Request approved' : `Request step ${currentStep}/${maxStep} approved`,
    );

    // Post-tx hook for external provisioning/deprovisioning (Graph, GitHub, etc.)
    if (isFinalStep && def.afterApprove) {
      void def.afterApprove(request.payload, requestId, actor.sub).catch((err: unknown) => {
        this.logger.error(
          { requestId, type: request.type },
          `afterApprove hook failed: ${String(err)}`,
        );
      });
    }

    return updated;
  }

  // ── Reject ────────────────────────────────────────────────────────────────

  async reject(requestId: string, note: string | null, actor: Actor): Promise<RequestItem> {
    const request = await this.getOrFail(requestId);
    this.assertApprovable(request.status);

    const def = this.registry.get(request.type);

    // Delegation check — same as approve()
    const activeDelegation = await this.delegation.findActiveDelegationTo(actor.sub);
    const sodSubject = activeDelegation ? activeDelegation.fromUserId : actor.sub;
    if (!def.allowSelfApproval && request.requesterId === sodSubject) {
      throw new PermissionDeniedException(
        'Requester cannot reject their own request',
        // The CODE, not a prefix on the message. A client distinguishing this from a missing
        // permission is the difference between "ask a colleague" and "ask for access".
        ErrorCodes.REQUEST_SOD_VIOLATION,
      );
    }

    // Resolve permission for current step (mirrors approve())
    const steps = def.approvalSteps;
    const currentStep = request.currentStep;
    const stepDef = steps?.find((s) => s.step === currentStep) ?? null;
    const requiredPermission = stepDef?.requiredPermission ?? def.requiredApprovalPermission;

    const actorAllowed = await this.authz.check(actor.sub, requiredPermission);
    const delegatorAllowed = activeDelegation
      ? await this.authz.check(activeDelegation.fromUserId, requiredPermission)
      : false;
    if (!actorAllowed && !delegatorAllowed) {
      throw new PermissionDeniedException(
        `Missing permission for step ${currentStep}: ${requiredPermission}`,
      );
    }

    const now = new Date();
    const updated = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(requestItems)
        .set({ status: 'rejected', resolvedAt: now, resolutionNote: note, updatedAt: now })
        .where(eq(requestItems.id, requestId))
        .returning();

      await tx.insert(requestApprovals).values({
        id: newId(),
        requestId,
        step: currentStep,
        approverId: actor.sub,
        decision: 'rejected',
        note,
        delegatedFromId: activeDelegation?.fromUserId ?? null,
      });

      if (def.onReject) {
        await def.onReject(request.payload, requestId, actor.sub, tx);
      }

      // Notify the requester their request has been rejected.
      await this.notifScheduler.schedule(tx, {
        type: 'request.rejected',
        vars: { requestType: request.type, requestId, reason: note ?? undefined },
        recipientId: request.requesterId,
        actorId: actor.sub,
        resourceId: requestId,
        idempotencyKey: `request_rejected:${requestId}`,
      });

      const rejectedPayload = { requestId, type: request.type, approverId: actor.sub, note };
      await this.webhookEnqueue.fanout(tx, 'request.rejected', rejectedPayload);

      return row;
    });

    this.logger.log({ requestId, type: request.type }, 'Request rejected');
    return updated;
  }

  // ── Cancel ─────────────────────────────────────────────────────────────────

  async cancel(requestId: string, actor: Actor): Promise<RequestItem> {
    const request = await this.getOrFail(requestId);

    // Only the requester (or an admin via rbac.manage) can cancel
    const canAdminCancel = await this.authz.check(actor.sub, 'rbac.manage');
    if (request.requesterId !== actor.sub && !canAdminCancel) {
      throw new PermissionDeniedException('Only the requester can cancel their own request');
    }

    if (request.status !== 'pending' && request.status !== 'in_review') {
      throw new PreconditionFailedException(
        'REQUEST_NOT_CANCELLABLE',
        `Cannot cancel a request with status '${request.status}'`,
      );
    }

    const def = this.registry.get(request.type);
    const now = new Date();

    const updated = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(requestItems)
        .set({ status: 'cancelled', resolvedAt: now, updatedAt: now })
        .where(eq(requestItems.id, requestId))
        .returning();

      if (def.onCancel) {
        await def.onCancel(request.payload, requestId, actor.sub, tx);
      }

      const cancelledPayload = { requestId, type: request.type, cancelledBy: actor.sub };
      await this.webhookEnqueue.fanout(tx, 'request.cancelled', cancelledPayload);

      return row;
    });

    return updated;
  }

  // ── Expire (called by worker cron) ─────────────────────────────────────────

  async expire(requestId: string): Promise<void> {
    const request = await this.getOrFail(requestId);
    if (request.status !== 'pending' && request.status !== 'in_review') return;

    const def = this.registry.get(request.type);
    const now = new Date();

    await this.db.transaction(async (tx) => {
      await tx
        .update(requestItems)
        .set({ status: 'expired', resolvedAt: now, updatedAt: now })
        .where(eq(requestItems.id, requestId));

      if (def.onExpire) {
        await def.onExpire(request.payload, requestId, tx);
      }

      const expiredPayload = { requestId, type: request.type };
      await this.webhookEnqueue.fanout(tx, 'request.expired', expiredPayload);
    });

    this.logger.log({ requestId, type: request.type }, 'Request expired');
  }

  // ── Query ──────────────────────────────────────────────────────────────────

  /**
   * Read one request, if the actor is a party to it or holds `request.read`.
   *
   * Performed no check at all before: any authenticated caller could read any request by id,
   * including its approval chain and the requester's justification.
   *
   * The check lives HERE and not in {@link loadUnchecked}, which the transitions use. An
   * approver is frequently neither the requester nor the current assignee — a multi-step chain
   * resolves the next assignee only when it advances — and `approve` already gates on the
   * step's own `requiredPermission`. Asserting party on the internal read would have refused
   * exactly the approvals this engine exists to route.
   */
  async getById(id: string, actor: Actor): Promise<RequestItemWithApprovals | null> {
    const item = await this.loadUnchecked(id);
    if (!item) return null;

    await this.actorScope.assertParty(
      [item.requesterId, item.assigneeId],
      actor,
      'request.read',
      'request',
    );

    /*
     * DECIDABILITY ON THE SINGLE READ TOO, computed here rather than inside `loadUnchecked`. That one
     * has no actor on purpose — the transitions use it and gate on their own permission — and a
     * default of `false` would be a lie to an approver reading a request they are perfectly able to
     * decide.
     */
    const decidable = await this.decidability([item], actor.sub);
    const verdict = decidable.get(item.id);
    return {
      ...item,
      viewerMayDecide: verdict?.may ?? false,
      viewerCannotDecideReason: verdict?.reason ?? null,
    };
  }

  /** The raw read, with no authorization: for transitions that gate on their own permission. */
  private async loadUnchecked(id: string): Promise<RequestItemWithApprovals | null> {
    const [row] = await this.db.select().from(requestItems).where(eq(requestItems.id, id)).limit(1);
    if (!row) return null;

    const approvalRows = await this.db
      .select()
      .from(requestApprovals)
      .where(eq(requestApprovals.requestId, id))
      .orderBy(
        asc(requestApprovals.step),
        asc(requestApprovals.decidedAt),
        asc(requestApprovals.id),
      );

    /*
     * Every person this request points at, in ONE query: the requester, the assignee it is waiting on, and
     * the approver on each step already decided. One list rather than three calls because the helper
     * deduplicates — a request an approver also filed is one id, not two — and because the three sets
     * overlap constantly in a multi-step chain, where step 1's approver is usually step 2's assignee.
     *
     * Nulls need no guard here: an unassigned request contributes nothing to the list, and a list with no
     * ids left costs no query at all.
     */
    const names = await resolveEmployeeNames(this.db, [
      row.requesterId,
      row.assigneeId,
      ...approvalRows.map((a) => a.approverId),
    ]);

    return {
      ...row,
      approvals: approvalRows.map((a) => ({ ...a, approverName: nameOf(names, a.approverId) })),
      requesterName: nameOf(names, row.requesterId),
      assigneeName: nameOf(names, row.assigneeId),
    };
  }

  /**
   * List requests the actor may see.
   *
   * NARROWS TO THE ACTOR WITHOUT `request.read`. Every condition below is derived from an
   * OPTIONAL filter, so `where` was `undefined` for an unfiltered call and this returned EVERY
   * request in the system — leave, onboarding, access, catalog — to any authenticated caller.
   * `actorId` was used for nothing but the `myQueue` shortcut. Found while giving each route an
   * explicit authorization declaration; no test covered it because no test called it unfiltered
   * as a principal without permissions.
   *
   * A party to a request is its requester OR its assignee, so the narrowed form is that
   * disjunction rather than `requesterId = actor` — an approver must still see their queue.
   */
  async list(
    filters: RequestFilters,
    actorId: string,
    limit: number,
    offset: number,
  ): Promise<{ rows: RequestItemWithApprovals[]; total: number }> {
    const unrestricted = await this.authz.check(actorId, 'request.read');

    const conditions = [
      filters.type ? eq(requestItems.type, filters.type) : undefined,
      filters.requesterId ? eq(requestItems.requesterId, filters.requesterId) : undefined,
      filters.status ? eq(requestItems.status, filters.status) : undefined,
      // "My queue" = what I can actually decide. See `decidableByPredicate` for what it used to mean.
      filters.myQueue
        ? await this.decidableByPredicate(actorId)
        : filters.assigneeId
          ? eq(requestItems.assigneeId, filters.assigneeId)
          : undefined,
      // The narrowing predicate, ANDed with whatever the caller asked for. Applied here rather
      // than by rewriting `filters` so a caller cannot widen it back out with `requesterId`.
      unrestricted
        ? undefined
        : or(eq(requestItems.requesterId, actorId), eq(requestItems.assigneeId, actorId)),
    ].filter(Boolean);

    const where = conditions.length ? and(...conditions) : undefined;

    const rows = await this.db
      .select()
      .from(requestItems)
      .where(where)
      .orderBy(desc(requestItems.createdAt), desc(requestItems.id))
      .limit(limit)
      .offset(offset);

    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(requestItems)
      .where(where);

    // Batch-load approvals in a single query — no N+1
    const ids = rows.map((r) => r.id);
    const allApprovals =
      ids.length > 0
        ? await this.db
            .select()
            .from(requestApprovals)
            .where(inArray(requestApprovals.requestId, ids))
            .orderBy(
              asc(requestApprovals.step),
              asc(requestApprovals.decidedAt),
              asc(requestApprovals.id),
            )
        : [];

    const approvalMap = new Map<string, RequestItemWithApprovals['approvals']>();
    /*
     * Collected in the loop that is already walking these rows rather than by a second `.map` over them:
     * the approvals were fetched for the page, so the approvers on them are known here for free, and
     * naming them must not cost a query of its own.
     */
    const approverIds: string[] = [];
    for (const a of allApprovals) {
      const key = (a as { requestId: string }).requestId;
      (approvalMap.get(key) ?? approvalMap.set(key, []).get(key)!).push(a);
      approverIds.push((a as { approverId: string }).approverId);
    }

    /*
     * Every person named on the page, in ONE query — the same reason the approvals above are batched.
     * Fifty rows must not become fifty lookups, and the alternative the SPA had was worse: it showed the
     * uuid, so an approver could not tell who was asking without opening each row.
     *
     * THREE SETS OF IDS, ONE CALL, on purpose. The requesters, the assignees each pending row is waiting
     * on, and the approvers on every decision already recorded — the approvals were fetched above, so
     * their ids were collected on the way past and cost nothing to add. A second `resolveEmployeeNames` would be a
     * second query for a set that overlaps this one almost entirely: in a multi-step chain the approver of
     * step 1 is the assignee of step 2, and a request somebody filed for themselves is one id twice. The
     * helper deduplicates, so the union is cheaper than any split of it.
     *
     * Shared with every other screen that names a person: this was the first place to need it and is
     * no longer the only one.
     */
    const names = await resolveEmployeeNames(this.db, [
      ...rows.map((r) => r.requesterId),
      ...rows.map((r) => r.assigneeId),
      ...approverIds,
    ]);

    // Whether this caller may decide each row, from the rule that would enforce it. See `decidability`.
    const decidable = await this.decidability(rows, actorId);

    return {
      rows: rows.map((r) => ({
        ...r,
        approvals: (approvalMap.get(r.id) ?? []).map((a) => ({
          ...a,
          // The audit trail of the decision, so it has to say WHO decided. Null when that employee's row
          // is gone: the decision outlives the decider, and a departed approver's is the one a review
          // comes back to.
          approverName: nameOf(names, a.approverId),
        })),
        // Null rather than absent when the employee row is gone: a request outlives its requester, and
        // an offboarded leaver's is the kind an auditor comes back to.
        requesterName: nameOf(names, r.requesterId),
        // Null for an UNASSIGNED request too, which is a normal pending state rather than a fault — any
        // holder of the step's permission may decide it. `assigneeId` still tells the two apart.
        assigneeName: nameOf(names, r.assigneeId),
        viewerMayDecide: decidable.get(r.id)?.may ?? false,
        viewerCannotDecideReason: decidable.get(r.id)?.reason ?? null,
      })),
      total: count,
    };
  }

  /**
   * Tell the people who can decide a request that it is waiting.
   *
   * ONE RECIPIENT IF SOMEBODY WAS NAMED, otherwise everyone the permission admits. `assigneeId` is
   * honoured first because naming an approver is a decision the caller made; the fan-out is what
   * happens in its absence, which — since no `resolverFn` exists — is every request in production.
   *
   * THE REQUESTER IS EXCLUDED. `approve()` refuses self-approval, so a prompt to decide your own
   * request is a prompt to collect a 403. An approver who raises a request still sees it in the
   * inbox as theirs; they are simply not asked to rule on it.
   *
   * A RECIPIENT PER ROW, not one row for many people, because `notification_preferences` is per user
   * and the read state is per user: a shared notification could be muted by one holder for all of
   * them, and marking it read would clear it from everybody's bell. The idempotency key carries the
   * recipient for the same reason — the relay dedupes on it, so a shared key would deliver to the
   * first holder and silently drop the rest.
   *
   * NOBODY TO TELL IS LOGGED, not swallowed. A step whose permission no one holds globally is a
   * request that cannot advance, and silence there looks identical to a working queue.
   */
  private async notifyDecisionMakers<K extends 'request.submitted' | 'request.step_ready'>(
    tx: DbExecutor,
    opts: {
      notificationType: K;
      vars: NotificationTemplateVars[K];
      requestId: string;
      assigneeId: string | null;
      requiredPermission: string;
      excludeUserId: string;
      idempotencyPrefix: string;
      actorId?: string;
    },
  ): Promise<void> {
    const recipients = opts.assigneeId
      ? [opts.assigneeId]
      : (await this.authz.globalHoldersOf(opts.requiredPermission, tx as DrizzleDB)).filter(
          (userId) => userId !== opts.excludeUserId,
        );

    if (recipients.length === 0) {
      this.logger.warn(
        {
          requestId: opts.requestId,
          requiredPermission: opts.requiredPermission,
          notificationType: opts.notificationType,
        },
        'No unconstrained holder of this permission — request submitted with nobody to notify',
      );
      return;
    }

    /*
     * NOT TRUNCATED, but said out loud. Capping the fan-out would silently pick winners among people
     * equally entitled to decide, and the cap would read as "everyone was told". A tenant where forty
     * people hold an approval permission has an RBAC problem worth seeing rather than hiding.
     */
    if (recipients.length > RequestEngine.WIDE_FANOUT_THRESHOLD) {
      this.logger.warn(
        {
          requestId: opts.requestId,
          requiredPermission: opts.requiredPermission,
          recipients: recipients.length,
        },
        'Wide approval fan-out — many principals hold this permission globally',
      );
    }

    for (const recipientId of recipients) {
      await this.notifScheduler.schedule(tx, {
        type: opts.notificationType,
        vars: opts.vars,
        recipientId,
        actorId: opts.actorId,
        resourceId: opts.requestId,
        idempotencyKey: `${opts.idempotencyPrefix}:${recipientId}`,
      });
    }
  }

  /**
   * The rows this actor may actually decide, as a SQL predicate — what "My queue" ought to mean.
   *
   * WHAT IT USED TO MEAN, and why that was not a queue. The filter was
   * `assigneeId = me OR (assigneeId IS NULL AND status = 'pending')`, and `assigneeId` is never
   * populated by anything: no `RequestTypeDef` defines a `resolverFn`, and no caller of `submit`
   * passes `opts.assigneeId`. So the first half never matched, and the second made "My queue" mean
   * *every unassigned pending request in the tenant* — byte-identical to the Pending tab beside it for
   * anybody holding `request.read`. For a caller without it, the narrowing collapsed the whole thing
   * to their OWN pending requests, listed under the caption "Nothing awaiting your decision", every
   * one of them a separation-of-duties refusal waiting to happen. And a request at step 2 vanished
   * from it entirely, because advancing sets `in_review` and the predicate demanded `pending` — the
   * half-approved requests, the ones most needing attention, were the ones it hid.
   *
   * WHAT IT MEANS NOW: open, not mine, and I hold the permission its current step requires. Derived
   * from the same type definitions `approve()` reads, so the queue and the refusal cannot disagree —
   * which is the whole reason this is expressible without inventing an assignment policy. Assigning
   * requests to people is a product decision nobody has made; being able to decide one is a fact.
   *
   * Expressed as `(type, currentStep)` pairs rather than a permission lookup per row, because the
   * pairs are few and known up front: one per step of each registered type.
   */
  private async decidableByPredicate(actorId: string) {
    const pairs: { type: string; step: number }[] = [];
    const selfApprovable: string[] = [];
    const checked = new Map<string, boolean>();

    const holds = async (permission: string): Promise<boolean> => {
      const cached = checked.get(permission);
      if (cached !== undefined) return cached;
      const result = await this.authz.check(actorId, permission);
      checked.set(permission, result);
      return result;
    };

    for (const def of this.registry.list()) {
      if (def.allowSelfApproval) selfApprovable.push(def.type);
      const steps = def.approvalSteps ?? [{ step: 1, requiredPermission: undefined }];
      for (const step of steps) {
        const required = step.requiredPermission ?? def.requiredApprovalPermission;
        if (await holds(required)) pairs.push({ type: def.type, step: step.step });
      }
    }

    // Nothing decidable at all: an explicitly false predicate, so the queue is empty rather than
    // unfiltered. `or()` of an empty list would drop the condition and show everything.
    if (pairs.length === 0) return sql`false`;

    const decidablePairs = or(
      ...pairs.map((pair) =>
        and(eq(requestItems.type, pair.type), eq(requestItems.currentStep, pair.step)),
      ),
    );

    return and(
      // `in_review` belongs here: a multi-step request that has cleared step 1 is exactly what the
      // next approver's queue is for, and the old predicate excluded it.
      or(eq(requestItems.status, 'pending'), eq(requestItems.status, 'in_review')),
      decidablePairs,
      // Separation of duties, unless the type allows self-approval. Without this the queue would list
      // requests whose only possible outcome is a refusal.
      selfApprovable.length > 0
        ? or(
            inArray(requestItems.type, selfApprovable),
            sql`${requestItems.requesterId} <> ${actorId}`,
          )
        : sql`${requestItems.requesterId} <> ${actorId}`,
    );
  }

  /**
   * Whether the actor may decide each of these requests — the same rule `approve()` enforces, asked
   * before the click rather than answered with a 403 after it.
   *
   * WHY IT LIVES HERE and not in the SPA. The permission depends on the type's `approvalSteps` keyed on
   * the row's CURRENT step; separation of duties is judged against the DELEGATOR when the caller is
   * acting under a delegation; and the permission may be satisfied by the caller or by that delegator.
   * A client-side copy would be a second implementation of the rule, free to drift from the one that
   * decides — and the inbox's actions were previously gated on nothing but the status, so every
   * unpermitted holder of `request.read` saw Approve on every pending request in the tenant.
   *
   * ONE DELEGATION LOOKUP AND ONE CHECK PER DISTINCT PERMISSION, not per row. A page of fifty leave
   * requests asks about one permission; the cache below is what keeps this from becoming fifty authz
   * round trips on a screen that already had to batch its names and its approvals.
   */
  private async decidability(
    rows: RequestItem[],
    actorId: string,
  ): Promise<
    Map<string, { may: boolean; reason: 'own_request' | 'missing_permission' | 'not_open' | null }>
  > {
    const out = new Map<
      string,
      { may: boolean; reason: 'own_request' | 'missing_permission' | 'not_open' | null }
    >();
    if (rows.length === 0) return out;

    const activeDelegation = await this.delegation.findActiveDelegationTo(actorId);
    const sodSubject = activeDelegation ? activeDelegation.fromUserId : actorId;
    const allowed = new Map<string, boolean>();

    const mayUse = async (permission: string): Promise<boolean> => {
      const cached = allowed.get(permission);
      if (cached !== undefined) return cached;
      // Union semantics, exactly as `approve()` applies them: the caller, or whoever delegated to them.
      const actorAllowed = await this.authz.check(actorId, permission);
      const delegatorAllowed =
        !actorAllowed && activeDelegation
          ? await this.authz.check(activeDelegation.fromUserId, permission)
          : false;
      const result = actorAllowed || delegatorAllowed;
      allowed.set(permission, result);
      return result;
    };

    for (const row of rows) {
      if (row.status !== 'pending' && row.status !== 'in_review') {
        out.set(row.id, { may: false, reason: 'not_open' });
        continue;
      }
      const def = this.registry.get(row.type);
      if (!def.allowSelfApproval && row.requesterId === sodSubject) {
        // Separation of duties, and it is worth naming: "ask a colleague" is different advice from
        // "ask for access", and the engine emits a distinct error code for exactly that reason.
        out.set(row.id, { may: false, reason: 'own_request' });
        continue;
      }
      const stepDef = def.approvalSteps?.find((step) => step.step === row.currentStep) ?? null;
      const required = stepDef?.requiredPermission ?? def.requiredApprovalPermission;
      const may = await mayUse(required);
      out.set(row.id, { may, reason: may ? null : 'missing_permission' });
    }

    return out;
  }

  /** Fetch IDs of pending requests past their deadline (for the expiry cron). */
  async findExpired(batchSize = 50): Promise<string[]> {
    const rows = await this.db
      .select({ id: requestItems.id })
      .from(requestItems)
      .where(
        and(
          or(eq(requestItems.status, 'pending'), eq(requestItems.status, 'in_review')),
          sql`${requestItems.expiresAt} < now()`,
          sql`${requestItems.expiresAt} is not null`,
        ),
      )
      .limit(batchSize);
    return rows.map((r) => r.id);
  }

  // ── Comments ───────────────────────────────────────────────────────────────

  /** Post a discussion comment on a request. Does not trigger any state transition. */
  async addComment(requestId: string, body: string, actor: Actor): Promise<RequestComment> {
    // Verify request exists (throws if not)
    const request = await this.getOrFail(requestId);
    // Commenting used to require only that the request EXISTED, so any authenticated caller
    // could post onto anyone's request — a write, on a record they cannot otherwise read.
    await this.actorScope.assertParty(
      [request.requesterId, request.assigneeId],
      actor,
      'request.read',
      'request',
    );

    const [row] = await this.db
      .insert(requestComments)
      .values({
        id: newId(),
        requestId,
        authorId: actor.sub,
        body: body.trim(),
      })
      .returning();

    return row;
  }

  /** List comments for a request, ordered oldest-first. */
  /** Comments are readable by the request's parties, or a holder of `request.read`. */
  async listComments(requestId: string, actor: Actor): Promise<RequestComment[]> {
    const request = await this.getOrFail(requestId);
    await this.actorScope.assertParty(
      [request.requesterId, request.assigneeId],
      actor,
      'request.read',
      'request',
    );

    const rows = await this.db
      .select()
      .from(requestComments)
      .where(eq(requestComments.requestId, requestId))
      .orderBy(asc(requestComments.createdAt), asc(requestComments.id));
    return rows;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async getOrFail(id: string): Promise<RequestItem> {
    const item = await this.loadUnchecked(id);
    if (!item) throw new NotFoundException('REQUEST_NOT_FOUND', `Request ${id} not found`);
    return item;
  }

  private assertApprovable(status: RequestStatus): void {
    if (status !== 'pending' && status !== 'in_review') {
      throw new PreconditionFailedException(
        'REQUEST_NOT_PENDING',
        `Request is already ${status} and cannot be approved or rejected`,
      );
    }
  }
}
