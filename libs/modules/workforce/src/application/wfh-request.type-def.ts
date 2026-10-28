import { Injectable, OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { type DbExecutor, RequestRegistry, RequestTypeDef } from '@platform';
import { AUDIT_ACTION, AUDIT_RESOURCE, AuditService } from '@modules/audit';
import { REQUEST_TYPE } from '@shared-kernel';
import { wfhRequests } from '../../../../../db/schema';

export interface WfhRequestPayload extends Record<string, unknown> {
  wfhRequestId: string;
  employeeId: string;
  startDate: string;
  endDate: string;
  /** What the window covers in working days, so a reviewer sees the size of what they approve. */
  workingDays: number;
  reason: string | null;
}

/**
 * RequestTypeDef for work-from-home requests. Syncs the domain-table status when the engine
 * transitions state, and records the decision — same contract as `LeaveRequestTypeDef`; see there
 * for why the hooks (and not the engine) are where the audit entry comes from.
 *
 * Expiry writes `cancelled`, not `rejected`: WFH asks permission to NOT come in, so an unanswered
 * request means "you are expected in the office", which is a withdrawal of the question rather than
 * a refusal of it. Overtime's `rejected` reads the opposite way because work already done is behind
 * the request.
 */
@Injectable()
export class WfhRequestTypeDef implements RequestTypeDef<WfhRequestPayload>, OnModuleInit {
  readonly type = REQUEST_TYPE.WFH_REQUEST;
  readonly requiredApprovalPermission = 'workforce.wfh.review';
  readonly allowSelfApproval = false;
  readonly defaultExpiryHours = 72; // 3 days
  /** SLA: notify if not approved within 48 h (2 business days) */
  readonly slaHours = 48;

  private readonly trail;

  constructor(
    private readonly registry: RequestRegistry,
    private readonly audit: AuditService,
  ) {
    this.trail = audit.forResource(AUDIT_RESOURCE.WFH_REQUEST);
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  async onApprove(
    payload: WfhRequestPayload,
    _requestId: string,
    reviewerId: string,
    tx: DbExecutor,
  ): Promise<void> {
    const now = new Date();
    await tx
      .update(wfhRequests)
      .set({ status: 'approved', reviewerId, reviewedAt: now })
      .where(eq(wfhRequests.id, payload.wfhRequestId));

    // `workingDays` on the entry, for the same reason leave carries it: the dates alone do not say
    // how much of the week this covers.
    await this.trail.record(
      AUDIT_ACTION.WFH_APPROVED,
      payload.wfhRequestId,
      { sub: reviewerId, email: reviewerId },
      tx,
      {
        before: { status: 'pending' },
        after: { status: 'approved', reviewedAt: now, workingDays: payload.workingDays },
      },
    );
  }

  async onReject(
    payload: WfhRequestPayload,
    _requestId: string,
    reviewerId: string,
    tx: DbExecutor,
  ): Promise<void> {
    const now = new Date();
    await tx
      .update(wfhRequests)
      .set({ status: 'rejected', reviewerId, reviewedAt: now })
      .where(eq(wfhRequests.id, payload.wfhRequestId));

    await this.trail.record(
      AUDIT_ACTION.WFH_REJECTED,
      payload.wfhRequestId,
      { sub: reviewerId, email: reviewerId },
      tx,
      { before: { status: 'pending' }, after: { status: 'rejected', reviewedAt: now } },
    );
  }

  async onExpire(payload: WfhRequestPayload, _requestId: string, tx: DbExecutor): Promise<void> {
    await tx
      .update(wfhRequests)
      .set({ status: 'cancelled' })
      .where(eq(wfhRequests.id, payload.wfhRequestId));

    // NO ACTOR — time did this, not a person. Same convention as `LeaveRequestTypeDef.onExpire`.
    await this.audit.record(
      {
        actorId: null,
        actorEmail: null,
        action: AUDIT_ACTION.WFH_CANCELLED,
        resourceType: AUDIT_RESOURCE.WFH_REQUEST,
        resourceId: payload.wfhRequestId,
        changes: {
          before: { status: 'pending' },
          after: { status: 'cancelled', reason: 'expired without review' },
        },
      },
      tx,
    );
  }
}
