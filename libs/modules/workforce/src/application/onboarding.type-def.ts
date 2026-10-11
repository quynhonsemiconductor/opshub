import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import {
  type ApprovalStepDef,
  type DbExecutor,
  InjectDrizzle,
  type DrizzleDB,
  RequestRegistry,
  RequestTypeDef,
} from '@platform';
import { GRAPH_TASK, GraphTaskQueue } from '@modules/graph';
import { REQUEST_TYPE } from '@shared-kernel';
import { employees } from '../../../../../db/schema';

export interface OnboardingPayload extends Record<string, unknown> {
  /** The employee being onboarded. */
  employeeId: string;
  employeeEmail: string;
  /** Requested start date (YYYY-MM-DD). */
  startDate: string;
  department?: string;
  jobTitle?: string;
  managerName?: string;
  equipmentType?: string;
  preferredOs?: string;
  equipmentNote?: string;
  accessNeeds?: string[];
}

/**
 * Three-step onboarding workflow:
 *   Step 1 — Manager approves the hire          (onboarding.approve)
 *   Step 2 — IT provisions access + equipment   (onboarding.provision)
 *   Step 3 — HR marks onboarding complete       (onboarding.complete)
 *
 * The engine handles all state transitions. `onApprove` is intentionally a
 * no-op because the employee is already `active` — all domain work (RBAC,
 * provisioning) happens out-of-band; the audit event is recorded by the
 * controller after `engine.submit` returns.
 */
@Injectable()
export class OnboardingTypeDef implements RequestTypeDef<OnboardingPayload>, OnModuleInit {
  private readonly logger = new Logger(OnboardingTypeDef.name);

  readonly type = REQUEST_TYPE.ONBOARDING;
  /** Fallback for single-step compatibility; not used in multi-step mode. */
  readonly requiredApprovalPermission = 'onboarding.complete';
  readonly allowSelfApproval = false;
  readonly defaultExpiryHours = 168; // 7 days
  readonly slaHours = 72; // 3 business days end-to-end

  // Annotated, not inferred: without `ApprovalStepDef[]` the literals widen `requiredPermission` to
  // `string`, which is precisely the typing the interface now refuses.
  readonly approvalSteps: ApprovalStepDef[] = [
    { step: 1, requiredPermission: 'onboarding.approve' },
    { step: 2, requiredPermission: 'onboarding.provision' },
    { step: 3, requiredPermission: 'onboarding.complete' },
  ];

  constructor(
    private readonly registry: RequestRegistry,
    @InjectDrizzle() private readonly db: DrizzleDB,
    private readonly graphTasks: GraphTaskQueue,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  /**
   * Final approval: queue the Entra account enable IN THE APPROVAL'S TRANSACTION.
   *
   * It used to run in `afterApprove`, after the commit and inside the approver's HTTP request, calling
   * Graph with the API's own credential. Now the API has none: the task row commits with the approval
   * (roll the approval back and there is no task), and the worker enables the account, retrying with
   * backoff. An employee without an Entra object id has no account to enable.
   */
  async onApprove(
    payload: OnboardingPayload,
    _requestId: string,
    _approverId: string,
    tx: DbExecutor,
  ): Promise<void> {
    const [row] = await tx
      .select({ entraOid: employees.entraOid })
      .from(employees)
      .where(eq(employees.id, payload.employeeId))
      .limit(1);

    if (!row?.entraOid) {
      this.logger.warn(
        `Onboarding approved: no Entra OID for employee ${payload.employeeId}, no account to enable`,
      );
      return;
    }

    await this.graphTasks.enqueue(
      { kind: GRAPH_TASK.ACCOUNT_SET_ENABLED, payload: { entraOid: row.entraOid, enabled: true } },
      tx,
    );
  }
}
