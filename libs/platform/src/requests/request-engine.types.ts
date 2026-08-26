import type { Permission, RequestType } from '@shared-kernel';
import type { DbExecutor } from '../database/drizzle.provider';
import type { requestPriorityEnum } from '../../../../db/schema';

export type RequestStatus =
  'pending' | 'in_review' | 'approved' | 'rejected' | 'cancelled' | 'expired';

/** Derived from the DB enum so adding a value there cannot leave this list stale. */
export type RequestPriority = (typeof requestPriorityEnum.enumValues)[number];

/**
 * Defines a single step in a multi-step approval chain.
 * Steps are processed in ascending `step` order.
 */
export interface ApprovalStepDef {
  /** 1-based step number. */
  step: number;
  /**
   * Permission required of the approver at this step.
   *
   * Typed against the catalogue rather than left as a `string`: this value never reaches a
   * `@RequirePermission` decorator, so `permissions.spec.ts` — which scans for decorator
   * literals — cannot see it. A code that exists nowhere therefore used to compile, seed
   * nothing, and deny every caller but the `*` holder. The type is the only place that check
   * can live.
   */
  requiredPermission: Permission;
  /**
   * Optional: resolve the default assignee for this step when the engine
   * advances to it. Called inside the approval transaction.
   * Return null = unassigned (any holder of requiredPermission can approve).
   */
  resolverFn?: (payload: Record<string, unknown>, db: DbExecutor) => Promise<string | null>;
}

/** A comment posted on a request item (non-decision, purely informational). */
export interface RequestComment {
  id: string;
  requestId: string;
  authorId: string;
  body: string;
  editedAt: Date | null;
  createdAt: Date;
}

export interface RequestItem {
  id: string;
  type: string;
  requesterId: string;
  assigneeId: string | null;
  status: RequestStatus;
  priority: RequestPriority;
  payload: Record<string, unknown>;
  resolutionNote: string | null;
  submittedAt: Date;
  resolvedAt: Date | null;
  expiresAt: Date | null;
  /** SLA threshold hours copied from the TypeDef at submit time. Null = no SLA. */
  slaHours: number | null;
  /** Absolute SLA deadline. Null if no SLA defined. */
  slaDeadline: Date | null;
  /** Timestamp of first SLA breach detection. Null = within SLA or no SLA. */
  slaBreachedAt: Date | null;
  /**
   * Which approval step the request is currently waiting on (1-based).
   * Always 1 for single-step workflows. Incremented as each step is approved.
   */
  currentStep: number;
  /** Total steps required as defined by the TypeDef. 1 for single-step. Immutable after submit. */
  totalSteps: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface RequestApproval {
  id: string;
  requestId: string;
  step: number;
  approverId: string;
  decision: 'approved' | 'rejected' | 'delegated';
  note: string | null;
  /**
   * If the approver was acting as a delegate for another user, this records
   * the original delegator. Null = direct approval (most common case).
   */
  delegatedFromId: string | null;
  decidedAt: Date;
}

/**
 * An approval row with its approver's display name resolved for the caller.
 *
 * Kept as a separate interface rather than a field on {@link RequestApproval}, for the same reason
 * {@link RequestItemWithApprovals} is separate from {@link RequestItem}: `RequestApproval` is the shape of
 * the stored row, and a name is not stored anywhere — it is joined on at read time, so only the read
 * shape should claim to have one.
 */
export interface RequestApprovalWithName extends RequestApproval {
  /**
   * The approver's display name, resolved for the caller.
   *
   * WHY IT IS NEEDED. The approval chain is the audit trail of the decision — it is the answer to "who
   * said yes to this" — and it rendered `approverId`, a bare uuid, for every step. A trail that cannot
   * name the decider does not discharge the review it exists for.
   *
   * Null when the approver's employee row is gone, and the decision outlives the decider by design: a
   * departed manager's approval is precisely the one an access review comes back to. Resolved through the
   * same batched lookup as the requester's name, so a page of decisions is still one query.
   */
  approverName?: string | null;
}

export interface RequestItemWithApprovals extends RequestItem {
  approvals: RequestApprovalWithName[];
  comments?: RequestComment[];
  /**
   * The requester's display name, resolved for the caller.
   *
   * WHY THE SERVER RESOLVES IT. `requesterId` is a uuid, and an approval queue that shows a uuid does
   * not say who is asking — so the inbox listed rows an approver could not decide from. The SPA could
   * look each id up, but a page of fifty rows is fifty requests for fifty names; the list already
   * batch-loads approvals in one query and this rides the same pattern.
   *
   * Null when the requester's row is gone. A request outlives the employee who filed it — an offboarded
   * leaver's access request is exactly the kind an auditor comes back to — so this is nullable rather
   * than an inner join that would make the request disappear with the person.
   */
  requesterName?: string | null;
  /**
   * The current assignee's display name, resolved for the caller.
   *
   * The assignee is the person a pending request is WAITING ON, so this is the field that answers "whose
   * desk is this sitting on" — and it was a uuid, which answers nothing. Chased from the drawer, where an
   * approver looking at somebody else's queue could not tell whether it was theirs.
   *
   * Null in two distinct cases, deliberately collapsed into one: the request has no assignee at all —
   * normal, since an unassigned pending request may be decided by any holder of the step's permission —
   * or it has one whose employee row is gone. Neither is an error and neither can be shown as a name, so
   * the caller renders a dash either way; `assigneeId` is still there to distinguish them.
   */
  assigneeName?: string | null;
  /**
   * Whether THIS CALLER may decide THIS request, answered by the engine that would enforce it.
   *
   * WHY THE SERVER ANSWERS IT. The inbox rendered Approve and Reject on every open row, so a
   * `request.read` holder with no approval permission — `helpdesk` and `auditor` hold exactly that —
   * saw the actions on every pending request in the tenant, and every click was a permanent 403. So
   * was every click on your own request, which the engine refuses by separation of duties.
   *
   * The client cannot work this out. The required permission comes from the type's `approvalSteps`
   * keyed on the CURRENT step, the separation-of-duties subject is the DELEGATOR when the caller is
   * acting under a delegation, and the permission may be satisfied by either the caller or that
   * delegator. Mirroring all of that in the SPA would be a second implementation of the rule, free to
   * drift from the one that decides.
   */
  viewerMayDecide?: boolean;
  /**
   * Why not, when they may not — so a screen can say something better than nothing.
   *
   * `own_request` is the separation-of-duties refusal and reads "ask a colleague"; `missing_permission`
   * reads "ask for access"; `not_open` means the request is already decided. The engine emits a
   * distinct error code for the first precisely so a client can tell those two apart, and the inbox
   * used to collapse every one of them into "please try again".
   */
  viewerCannotDecideReason?: 'own_request' | 'missing_permission' | 'not_open' | null;
}

export interface SubmitRequestOptions {
  /** Absolute expiry time. Overrides TypeDef.defaultExpiryHours. */
  expiresAt?: Date;
  priority?: RequestPriority;
  /** ID of the employee who should review this request (overrides TypeDef resolver). */
  assigneeId?: string;
}

export interface RequestFilters {
  type?: string;
  requesterId?: string;
  assigneeId?: string;
  status?: RequestStatus;
  /** Return only requests the caller is the current assignee on. */
  myQueue?: boolean;
}

/**
 * Strategy interface: one implementation per request workflow type.
 *
 * `type` is the discriminator key. `requiredApprovalPermission` is checked
 * against the approver's effective RBAC grants before any approval is recorded.
 * Lifecycle hooks receive the same `tx` so side-effects are atomic.
 *
 * `onApprove` is required (creates domain records, e.g. access_grants).
 * All other hooks are optional; the engine handles the state transition itself.
 */
export interface RequestTypeDef<TPayload = Record<string, unknown>> {
  /** Unique discriminator, e.g. 'access_request' | 'leave_request' | 'overtime'. */
  readonly type: RequestType;
  /**
   * Permission key required of the approver, e.g. 'access_request.approve'. Used for a
   * single-step type, and as the fallback when `approvalSteps` names no step for the current one.
   *
   * Typed for the same reason as `ApprovalStepDef.requiredPermission` — see there.
   */
  readonly requiredApprovalPermission: Permission;
  /** When false (default), requester cannot approve their own request (SoD). */
  readonly allowSelfApproval?: boolean;
  /** Auto-expire after N hours with no decision. 0 = no expiry. */
  readonly defaultExpiryHours?: number;
  /**
   * SLA threshold in hours. If set, a `sla_deadline` is stored at submit time.
   * The SlaBreachCron notifies stakeholders when the deadline passes without a decision.
   * This is separate from expiry: SLA breach = notification only; expiry = auto-cancel.
   */
  readonly slaHours?: number;
  /**
   * Multi-step approval chain. When provided, overrides `requiredApprovalPermission`
   * (each step carries its own permission). Steps are processed in ascending step
   * number order. `onApprove` is called only when the **final** step is approved.
   *
   * If absent, falls back to single-step behavior using `requiredApprovalPermission`.
   */
  readonly approvalSteps?: ApprovalStepDef[];
  /** Called inside the submit transaction. Use for domain validation (e.g. overlap check). */
  onSubmit?(payload: TPayload, requesterId: string, tx: DbExecutor): Promise<void>;
  /** Called inside the approval transaction. REQUIRED: create domain records here. */
  onApprove(
    payload: TPayload,
    requestId: string,
    approverId: string,
    tx: DbExecutor,
  ): Promise<void>;
  /**
   * Called inside the transaction when an **intermediate** step is approved (not the final step).
   * Use to send notifications or perform intermediate domain actions.
   * The engine has already updated `currentStep` and `assigneeId` before calling this.
   */
  onStepApproved?(
    payload: TPayload,
    requestId: string,
    completedStep: number,
    nextStep: number,
    nextAssigneeId: string | null,
    approverId: string,
    tx: DbExecutor,
  ): Promise<void>;
  /** Called inside the rejection transaction. Update domain table status here. */
  onReject?(
    payload: TPayload,
    requestId: string,
    approverId: string,
    tx: DbExecutor,
  ): Promise<void>;
  /** Called inside the cancellation transaction. */
  onCancel?(
    payload: TPayload,
    requestId: string,
    cancelledBy: string,
    tx: DbExecutor,
  ): Promise<void>;
  /** Called inside the expiry transaction (from the worker's expiry cron). */
  onExpire?(payload: TPayload, requestId: string, tx: DbExecutor): Promise<void>;
  /**
   * Optional post-transaction hook called AFTER the approval transaction commits.
   * Use for external API calls (Graph, GitHub, etc.) that must not hold the DB tx open.
   * Failures are logged but do NOT roll back the already-committed DB state.
   */
  afterApprove?(payload: TPayload, requestId: string, approverId: string): Promise<void>;
}
