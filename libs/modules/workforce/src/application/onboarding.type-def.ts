import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
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
   * Final approval: queue an Entra account reconcile IN THE APPROVAL'S TRANSACTION.
   *
   * The task names the employee and nothing else. The worker reads their status and Entra object id when
   * it runs and sets the account to match, so this can never enable an account whose owner has been
   * offboarded since — the stale-enable race a "set enabled = true" payload would have.
   */
  async onApprove(
    payload: OnboardingPayload,
    _requestId: string,
    _approverId: string,
    tx: DbExecutor,
  ): Promise<void> {
    await this.graphTasks.enqueue(
      { kind: GRAPH_TASK.ACCOUNT_RECONCILE, payload: { employeeId: payload.employeeId } },
      tx,
    );
  }
}
