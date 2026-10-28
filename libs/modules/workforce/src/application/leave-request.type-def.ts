import { Injectable, OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { type DbExecutor, RequestRegistry, RequestTypeDef } from '@platform';
import { AUDIT_ACTION, AUDIT_RESOURCE, AuditService } from '@modules/audit';
import { REQUEST_TYPE } from '@shared-kernel';
import { leaveRequests } from '../../../../../db/schema';
import type { LeaveDayPortion } from '../domain/workforce.types';

export interface LeaveRequestPayload extends Record<string, unknown> {
  leaveRequestId: string;
  employeeId: string;
  leaveType: string;
  startDate: string;
  endDate: string;
  /** Which part of the first and last day the window covers — `full_day` unless part-day. */
  startPortion: LeaveDayPortion;
  endPortion: LeaveDayPortion;
  /** What the window costs in days, so a reviewer sees the size of what they are approving. */
  workingDays: number;
  reason: string | null;
}

/**
 * RequestTypeDef for leave requests. Syncs the domain-table status when the
 * engine transitions state, so existing queries against `workforce.leave_requests`
 * continue to work unchanged.
 *
 * AND RECORDS THE DECISION, which nothing did. `RequestEngine` writes no audit entry for any
 * transition — it owns `request_items` and leaves the domain event to the type that defines it — and
 * these hooks wrote the status change and stopped. The only `leave.approved` / `leave.rejected` writes
 * in the codebase sat in a `// Legacy path` branch of `WorkforceService.reviewLeave` that
 * `createLeave` made unreachable the moment it started setting `requestId` on every row.
 *
 * So approving leave produced no audit entry at all, on a service whose own docblock calls these "the
 * decisions people are paid on". Expiry was worse: `onExpire` cancels somebody's leave request with no
 * record that anything happened, and no actor to attribute it to.
 */
@Injectable()
export class LeaveRequestTypeDef implements RequestTypeDef<LeaveRequestPayload>, OnModuleInit {
  readonly type = REQUEST_TYPE.LEAVE_REQUEST;
  readonly requiredApprovalPermission = 'workforce.leave.review';
  readonly allowSelfApproval = false;
  readonly defaultExpiryHours = 72; // 3 days
  /** SLA: notify if not approved within 48 h (2 business days) */
  readonly slaHours = 48;

  private readonly trail;

  constructor(
    private readonly registry: RequestRegistry,
    private readonly audit: AuditService,
  ) {
    this.trail = audit.forResource(AUDIT_RESOURCE.LEAVE_REQUEST);
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  /**
   * The domain row must still be pending when a decision lands. The engine refuses a decided
   * request, but the DOMAIN status is this table's to keep in step: without the guard, a cancel
   * and an approve racing through two doors could both write, and the second one wins silently.
   */
  private async assertPending(tx: DbExecutor, id: string): Promise<void> {
    const [row] = await tx
      .select({ status: leaveRequests.status })
      .from(leaveRequests)
      .where(eq(leaveRequests.id, id))
      .limit(1);
    if (!row || row.status !== 'pending') {
      throw new Error(`leave request ${id} is not pending`);
    }
  }

  async onApprove(
    payload: LeaveRequestPayload,
    _requestId: string,
    reviewerId: string,
    tx: DbExecutor,
  ): Promise<void> {
    await this.assertPending(tx, payload.leaveRequestId);
    const now = new Date();
    await tx
      .update(leaveRequests)
      .set({ status: 'approved', reviewerId, reviewedAt: now })
      .where(eq(leaveRequests.id, payload.leaveRequestId));

    /*
     * In the engine's transaction, so the entry commits with the decision and rolls back with it.
     *
     * `workingDays` travels on the entry because it is what the approval actually COST — the dates
     * alone do not say whether this was two days or two days minus an afternoon.
     *
     * The engine hands these hooks a reviewer id and no email, and `AuditService` records both, so the
     * id is carried in both fields — visibly derived rather than silently blank. Same convention as
     * `RiskAcceptanceTypeDef` and the offboarding hook.
     */
    await this.trail.record(
      AUDIT_ACTION.LEAVE_APPROVED,
      payload.leaveRequestId,
      { sub: reviewerId, email: reviewerId },
      tx,
      {
        before: { status: 'pending' },
        after: { status: 'approved', reviewedAt: now, workingDays: payload.workingDays },
      },
    );
  }

  async onReject(
    payload: LeaveRequestPayload,
    _requestId: string,
    reviewerId: string,
    tx: DbExecutor,
  ): Promise<void> {
    await this.assertPending(tx, payload.leaveRequestId);
    const now = new Date();
    await tx
      .update(leaveRequests)
      .set({ status: 'rejected', reviewerId, reviewedAt: now })
      .where(eq(leaveRequests.id, payload.leaveRequestId));

    await this.trail.record(
      AUDIT_ACTION.LEAVE_REJECTED,
      payload.leaveRequestId,
      { sub: reviewerId, email: reviewerId },
      tx,
      { before: { status: 'pending' }, after: { status: 'rejected', reviewedAt: now } },
    );
  }

  /**
   * A withdrawal the REQUESTER chose (engine.cancel), distinct from expiry: an actor is named, and
   * the engine row and this row change in the SAME transaction — the pre-existing bug was the
   * service writing the domain status alone, leaving the engine item pending forever.
   */
  async onCancel(
    payload: LeaveRequestPayload,
    _requestId: string,
    cancelledBy: string,
    tx: DbExecutor,
  ): Promise<void> {
    await this.assertPending(tx, payload.leaveRequestId);
    await tx
      .update(leaveRequests)
      .set({ status: 'cancelled' })
      .where(eq(leaveRequests.id, payload.leaveRequestId));
    await this.trail.record(
      AUDIT_ACTION.LEAVE_CANCELLED,
      payload.leaveRequestId,
      { sub: cancelledBy, email: cancelledBy },
      tx,
      { before: { status: 'pending' }, after: { status: 'cancelled' } },
    );
  }

  async onExpire(payload: LeaveRequestPayload, _requestId: string, tx: DbExecutor): Promise<void> {
    await tx
      .update(leaveRequests)
      .set({ status: 'cancelled' })
      .where(eq(leaveRequests.id, payload.leaveRequestId));

    /*
     * NO ACTOR, because time did this rather than a person.
     *
     * `actorId: null` is what distinguishes an expiry sweep from somebody cancelling their own leave —
     * `ContractExpiryCron` records its sweep the same way, and for the same reason. Naming the
     * requester would read as "they cancelled it", which is the opposite of what happened: they asked,
     * and nobody answered in time. The trail interface takes an `Actor`, so this goes through the raw
     * recorder instead.
     */
    await this.audit.record(
      {
        actorId: null,
        actorEmail: null,
        action: AUDIT_ACTION.LEAVE_CANCELLED,
        resourceType: AUDIT_RESOURCE.LEAVE_REQUEST,
        resourceId: payload.leaveRequestId,
        changes: {
          before: { status: 'pending' },
          after: { status: 'cancelled', reason: 'expired without review' },
        },
      },
      tx,
    );
  }
}
