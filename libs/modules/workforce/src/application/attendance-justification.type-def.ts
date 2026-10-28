import { Injectable, OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { type DbExecutor, RequestRegistry, RequestTypeDef } from '@platform';
import { AUDIT_ACTION, AUDIT_RESOURCE, AuditService } from '@modules/audit';
import { REQUEST_TYPE } from '@shared-kernel';
import { assertMonthsOpenInTx } from '../domain/attendance-month-lock';
import { attendanceJustifications } from '../../../../../db/schema';

export interface AttendanceJustificationPayload extends Record<string, unknown> {
  justificationId: string;
  employeeId: string;
  startDate: string;
  endDate: string;
  kind: 'late' | 'early' | 'forgot_card' | 'missing_checkout';
  /** What the window covers in working days, so a reviewer sees the size of what they approve. */
  workingDays: number;
  reason: string | null;
}

/**
 * RequestTypeDef for attendance justifications. Syncs the domain-table status when the engine
 * transitions state, and records the decision — same contract as `LeaveRequestTypeDef` and
 * `WfhRequestTypeDef`; see the leave one for why the hooks (and not the engine) are where the audit
 * entry comes from.
 *
 * A justification explains days rather than spending them, so it is approved or rejected AS A
 * WHOLE over its range and coexists with leave and WFH (no overlap rule, unlike WFH-vs-leave).
 * Expiry writes `cancelled`, like WFH: nobody answering is not a refusal of the explanation.
 */
@Injectable()
export class AttendanceJustificationTypeDef
  implements RequestTypeDef<AttendanceJustificationPayload>, OnModuleInit
{
  readonly type = REQUEST_TYPE.ATTENDANCE_JUSTIFICATION;
  readonly requiredApprovalPermission = 'workforce.attendance.review';
  readonly allowSelfApproval = false;
  readonly defaultExpiryHours = 72; // 3 days
  /** SLA: notify if not approved within 48 h (2 business days) */
  readonly slaHours = 48;

  private readonly trail;

  constructor(
    private readonly registry: RequestRegistry,
    private readonly audit: AuditService,
  ) {
    this.trail = audit.forResource(AUDIT_RESOURCE.ATTENDANCE_JUSTIFICATION);
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  /** The domain row must still be pending when a decision lands — see LeaveRequestTypeDef. */
  private async assertPending(tx: DbExecutor, id: string): Promise<void> {
    const [row] = await tx
      .select({ status: attendanceJustifications.status })
      .from(attendanceJustifications)
      .where(eq(attendanceJustifications.id, id))
      .limit(1);
    if (!row || row.status !== 'pending') {
      throw new Error(`justification ${id} is not pending`);
    }
  }

  async onApprove(
    payload: AttendanceJustificationPayload,
    _requestId: string,
    reviewerId: string,
    tx: DbExecutor,
  ): Promise<void> {
    await this.assertPending(tx, payload.justificationId);
    await assertMonthsOpenInTx(tx, payload.startDate, payload.endDate, 'Deciding a justification');
    const now = new Date();
    await tx
      .update(attendanceJustifications)
      .set({ status: 'approved', reviewerId, reviewedAt: now })
      .where(eq(attendanceJustifications.id, payload.justificationId));

    // `kind` and `workingDays` on the entry, because that is what the approval asserts: "the late
    // arrival on 3 days was accepted", not just "something was approved".
    await this.trail.record(
      AUDIT_ACTION.ATTENDANCE_JUSTIFICATION_APPROVED,
      payload.justificationId,
      { sub: reviewerId, email: reviewerId },
      tx,
      {
        before: { status: 'pending' },
        after: {
          status: 'approved',
          reviewedAt: now,
          kind: payload.kind,
          workingDays: payload.workingDays,
        },
      },
    );
  }

  async onReject(
    payload: AttendanceJustificationPayload,
    _requestId: string,
    reviewerId: string,
    tx: DbExecutor,
  ): Promise<void> {
    await this.assertPending(tx, payload.justificationId);
    await assertMonthsOpenInTx(tx, payload.startDate, payload.endDate, 'Deciding a justification');
    const now = new Date();
    await tx
      .update(attendanceJustifications)
      .set({ status: 'rejected', reviewerId, reviewedAt: now })
      .where(eq(attendanceJustifications.id, payload.justificationId));

    await this.trail.record(
      AUDIT_ACTION.ATTENDANCE_JUSTIFICATION_REJECTED,
      payload.justificationId,
      { sub: reviewerId, email: reviewerId },
      tx,
      { before: { status: 'pending' }, after: { status: 'rejected', reviewedAt: now } },
    );
  }

  /** The requester's own withdrawal, in the engine's transaction — guarded pending, month-open. */
  async onCancel(
    payload: AttendanceJustificationPayload,
    _requestId: string,
    cancelledBy: string,
    tx: DbExecutor,
  ): Promise<void> {
    await this.assertPending(tx, payload.justificationId);
    await assertMonthsOpenInTx(
      tx,
      payload.startDate,
      payload.endDate,
      'Withdrawing a justification',
    );
    await tx
      .update(attendanceJustifications)
      .set({ status: 'cancelled' })
      .where(eq(attendanceJustifications.id, payload.justificationId));
    await this.trail.record(
      AUDIT_ACTION.ATTENDANCE_JUSTIFICATION_CANCELLED,
      payload.justificationId,
      { sub: cancelledBy, email: cancelledBy },
      tx,
      { before: { status: 'pending' }, after: { status: 'cancelled' } },
    );
  }

  async onExpire(
    payload: AttendanceJustificationPayload,
    _requestId: string,
    tx: DbExecutor,
  ): Promise<void> {
    await tx
      .update(attendanceJustifications)
      .set({ status: 'cancelled' })
      .where(eq(attendanceJustifications.id, payload.justificationId));

    // NO ACTOR — time did this, not a person. Same convention as the leave and WFH hooks.
    await this.audit.record(
      {
        actorId: null,
        actorEmail: null,
        action: AUDIT_ACTION.ATTENDANCE_JUSTIFICATION_CANCELLED,
        resourceType: AUDIT_RESOURCE.ATTENDANCE_JUSTIFICATION,
        resourceId: payload.justificationId,
        changes: {
          before: { status: 'pending' },
          after: { status: 'cancelled', reason: 'expired without review' },
        },
      },
      tx,
    );
  }
}
