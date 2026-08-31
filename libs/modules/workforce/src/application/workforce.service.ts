import { Inject, Injectable } from '@nestjs/common';
import {
  AuthzService,
  ConflictException,
  NotFoundException,
  PermissionDeniedException,
  PreconditionFailedException,
  ErrorCodes,
  RequestEngine,
  StorageService,
  ActorScope,
  InjectDrizzle,
} from '@platform';
import type { DrizzleDB } from '@platform';
import type { PresignUploadResult } from '@platform';
import {
  AuditService,
  AUDIT_ACTION,
  AUDIT_RESOURCE,
  type ResourceAuditTrail,
} from '@modules/audit';
import { LeaveBalanceService, type LeaveBalance } from './leave-balance.service';
import { MS_PER_HOUR, type Actor } from '@shared-kernel';
import {
  WORKFORCE_REPOSITORY,
  type IWorkforceRepository,
} from '../domain/ports/workforce.repository';
import type {
  LeaveType,
  CreateLeaveInput,
  CreateOvertimeInput,
  CreateShiftLogInput,
  CreateTimesheetInput,
  LeaveFilters,
  LeaveRequest,
  OvertimeEntry,
  OvertimeFilters,
  ShiftLog,
  ShiftLogFilters,
  Timesheet,
  TimesheetFilters,
} from '../domain/workforce.types';
import {
  leaveWindowViolation,
  leaveWindowsOverlap,
  type LeaveWindow,
} from '../domain/leave-window';
import type { LeaveRequestPayload } from './leave-request.type-def';
import type { OvertimePayload } from './overtime.type-def';
import type { OnboardingPayload } from './onboarding.type-def';
import type { OffboardingPayload } from './offboarding.type-def';

/**
 * Timesheets, leave, overtime, shifts and the on/offboarding submissions.
 *
 * AUDIT ENTRIES SHARE THEIR MUTATION'S TRANSACTION. Every write here was fire-and-forget, and these are the
 * decisions people are paid on: an approved timesheet or an approved leave request with no entry leaves
 * nothing to answer "who approved this" with.
 *
 * THE TWO EXCEPTIONS are the on/offboarding submissions, where `RequestEngine` owns the only write and its
 * own row IS the request — so there is no transaction of ours to join. Named at each site.
 */
@Injectable()
export class WorkforceService {
  private readonly timesheetTrail: ResourceAuditTrail;
  private readonly leaveTrail: ResourceAuditTrail;
  private readonly overtimeTrail: ResourceAuditTrail;
  private readonly employeeTrail: ResourceAuditTrail;
  private readonly entitlementTrail: ResourceAuditTrail;
  private readonly holidayTrail: ResourceAuditTrail;

  constructor(
    @Inject(WORKFORCE_REPOSITORY) private readonly repo: IWorkforceRepository,
    audit: AuditService,
    private readonly engine: RequestEngine,
    private readonly storage: StorageService,
    private readonly authz: AuthzService,
    private readonly actorScope: ActorScope,
    private readonly balances: LeaveBalanceService,
    @InjectDrizzle() private readonly db: DrizzleDB,
  ) {
    this.timesheetTrail = audit.forResource(AUDIT_RESOURCE.TIMESHEET);
    this.leaveTrail = audit.forResource(AUDIT_RESOURCE.LEAVE_REQUEST);
    this.overtimeTrail = audit.forResource(AUDIT_RESOURCE.OVERTIME_ENTRY);
    this.employeeTrail = audit.forResource(AUDIT_RESOURCE.EMPLOYEE);
    this.entitlementTrail = audit.forResource(AUDIT_RESOURCE.LEAVE_ENTITLEMENT);
    this.holidayTrail = audit.forResource(AUDIT_RESOURCE.HOLIDAY);
  }

  // ── Access narrowing ───────────────────────────────────────────────────────

  /**
   * Constrain a list query to what `actor` may actually read.
   *
   * The four workforce collections all expose an OPTIONAL `employeeId` filter, and
   * they hold HR records: hours worked, leave reasons, overtime, shift history. That
   * combination is why the check lives here and not in a `@RequirePermission` scope
   * descriptor. A descriptor reads the attribute off the request, so it can only
   * answer "may I act on employee X" once X is named — when `employeeId` is omitted
   * the guard resolves no resource and, per {@link AuthzService.check}, denies. A
   * self-service caller listing their own timesheets sends no filter at all (the SPA
   * never sends one), so the decorator would 403 the common case while still leaving
   * an unfiltered global read for anyone holding the permission broadly.
   *
   * So the tier is decided first, then the filter is applied:
   *
   *  - holding `workforce.read` UNCONSTRAINED (a `global` grant — `check` with no
   *    resource returns true only for those) means HR-wide read: the filter passes
   *    through untouched, including "no filter" for a full listing;
   *  - everyone else is pinned to their own records. `employeeId` is set to
   *    `actor.sub`, which is the same identifier the create paths stamp
   *    (`createTimesheet` writes `employeeId: actor.sub`) and the same one
   *    `ScopeEvaluator`'s `self` matcher compares against.
   *
   * Asking for someone else's records without the permission is DENIED rather than
   * silently narrowed to your own. Silent narrowing would return a plausible page of
   * the wrong person's data — indistinguishable, to the caller, from "that employee
   * has no records", which is a worse answer than a 403.
   */
  private narrowToActor<T extends { employeeId?: string }>(filters: T, actor: Actor): Promise<T> {
    // Delegates to ActorScope, which is this method generalised: the request engine and the
    // access-request module needed the identical rule, and a third copy of an authorization
    // decision is a third chance for one to drift. The rule itself is unchanged — asking for
    // someone else's records without the permission is DENIED, not silently narrowed.
    return this.actorScope.narrowFilter(filters, 'employeeId', actor, 'workforce.read');
  }

  /**
   * Assert `actor` may act on a record owned by `ownerId`.
   *
   * Used by the two transitions that are the owner's own act — submitting a timesheet
   * for approval, and withdrawing a leave request. Both previously took the actor and
   * discarded it (`_actor`), so any authenticated user could submit another employee's
   * draft or cancel their approved leave, with the audit trail naming the wrong person
   * as having done it.
   *
   * `workforce.approve` held unconstrained also passes: an HR administrator acting on
   * an employee's behalf is a real workflow, and that permission already gates the
   * review routes next door.
   */
  private async assertOwnerOrApprover(ownerId: string, actor: Actor): Promise<void> {
    if (ownerId === actor.sub) return;
    if (await this.authz.check(actor.sub, 'workforce.approve')) return;
    throw new PermissionDeniedException(
      'Missing permission: workforce.approve — this record belongs to another employee',
    );
  }

  // ── Timesheets ─────────────────────────────────────────────────────────────
  async createTimesheet(
    input: Omit<CreateTimesheetInput, 'employeeId'>,
    actor: Actor,
  ): Promise<Timesheet> {
    return this.repo.createTimesheet({ ...input, employeeId: actor.sub });
  }

  /**
   * Bulk draft creation, all-or-nothing: the repository writes every entry in ONE insert, so a
   * failure anywhere rolls the whole batch back — a half-imported week of timesheets is worse
   * than an unimported one, because the caller cannot tell which rows landed. Validation has
   * already happened upstream, so the only failures left here are database ones.
   *
   * Same self-scoping as {@link createTimesheet}: every entry is filed BY the caller, there is no
   * employeeId in the payload to trust.
   */
  async createTimesheetsBulk(
    inputs: Omit<CreateTimesheetInput, 'employeeId'>[],
    actor: Actor,
  ): Promise<Timesheet[]> {
    return this.db.transaction(async (tx) => {
      const created = await this.repo.createTimesheets(
        inputs.map((input) => ({ ...input, employeeId: actor.sub })),
        tx,
      );
      // One entry per row, same action as a single create, in the SAME transaction as the
      // insert — a batch that rolls back leaves no orphaned audit rows behind it.
      for (const ts of created) {
        await this.timesheetTrail.record(AUDIT_ACTION.TIMESHEET_CREATED, ts.id, actor, tx, {
          workDate: ts.workDate,
          minutesWorked: ts.minutesWorked,
        });
      }
      return created;
    });
  }

  async getTimesheet(id: string): Promise<Timesheet> {
    const t = await this.repo.findTimesheetById(id);
    if (!t) throw new NotFoundException(ErrorCodes.TIMESHEET_NOT_FOUND, 'Timesheet not found');
    return t;
  }

  async listTimesheets(
    filters: TimesheetFilters,
    limit: number,
    offset: number,
    actor: Actor,
  ): Promise<{ rows: Timesheet[]; total: number }> {
    return this.repo.listTimesheets(await this.narrowToActor(filters, actor), limit, offset);
  }

  async submitTimesheet(id: string, actor: Actor): Promise<Timesheet> {
    const t = await this.getTimesheet(id);
    await this.assertOwnerOrApprover(t.employeeId, actor);
    if (t.status !== 'draft' && t.status !== 'rejected') {
      throw new PreconditionFailedException(
        ErrorCodes.TIMESHEET_NOT_EDITABLE,
        'Only draft or rejected timesheets can be submitted',
      );
    }
    const updated = await this.repo.setTimesheetStatus(id, 'submitted', null);
    return updated!;
  }

  async reviewTimesheet(id: string, approve: boolean, actor: Actor): Promise<Timesheet> {
    const t = await this.getTimesheet(id);
    /*
     * NOBODY APPROVES THEIR OWN TIMESHEET. This is the record payroll is computed from, so it is the
     * one in this module where self-approval matters most — and it was the one place without the
     * check.
     *
     * Leave and overtime are routed through the request engine, which refuses self-approval by
     * `allowSelfApproval: false` on their type definitions. Timesheets never go near the engine:
     * `reviewTimesheet` writes the status directly, so it inherited none of that and compared the
     * actor to nothing. A `workforce.approve` holder could submit their own hours and approve them.
     *
     * Same error code the engine uses, so a client can tell "ask a colleague" from "ask for access"
     * without knowing which of the two paths answered it.
     */
    if (t.employeeId === actor.sub) {
      throw new PermissionDeniedException(
        'You cannot approve or reject your own timesheet — payroll is computed from it',
        ErrorCodes.REQUEST_SOD_VIOLATION,
      );
    }
    if (t.status !== 'submitted') {
      throw new PreconditionFailedException(
        ErrorCodes.TIMESHEET_NOT_EDITABLE,
        'Only submitted timesheets can be reviewed',
      );
    }
    return this.db.transaction(async (tx) => {
      const updated = await this.repo.setTimesheetStatus(
        id,
        approve ? 'approved' : 'rejected',
        approve ? actor.sub : null,
        tx,
      );
      await this.timesheetTrail.record(
        approve ? AUDIT_ACTION.TIMESHEET_APPROVED : AUDIT_ACTION.TIMESHEET_REJECTED,
        id,
        actor,
        tx,
        { before: { status: t.status }, after: { status: approve ? 'approved' : 'rejected' } },
      );
      return updated!;
    });
  }

  // ── Leave ──────────────────────────────────────────────────────────────────
  async createLeave(
    input: Omit<CreateLeaveInput, 'employeeId'>,
    actor: Actor,
  ): Promise<LeaveRequest> {
    // The window, portions included. `full_day` at both ends unless asked otherwise, so a caller
    // that says nothing about portions books whole days exactly as it did before migration 0028.
    const window: LeaveWindow = {
      startDate: input.startDate,
      endDate: input.endDate,
      startPortion: input.startPortion ?? 'full_day',
      endPortion: input.endPortion ?? 'full_day',
    };

    // Every one of these is also a CHECK on the table. Restated here because a raw constraint
    // violation reaches the caller as a 500 with no code, and "morning to afternoon" is a mistake
    // somebody will make — it reads like a whole day, and the whole day is what `full_day` is for.
    const violation = leaveWindowViolation(window);
    if (violation) {
      throw new PreconditionFailedException(ErrorCodes.LEAVE_INVALID_WINDOW, violation);
    }

    // The date-range test finds the CANDIDATES in SQL; the portions decide. A morning off and an
    // afternoon off on the same date share a date and no time, so refusing the second would be
    // refusing leave the employee can see is free.
    const candidates = await this.repo.overlappingLeaveCandidates(
      actor.sub,
      input.startDate,
      input.endDate,
    );
    if (candidates.some((existing) => leaveWindowsOverlap(window, existing))) {
      throw new ConflictException(
        ErrorCodes.LEAVE_OVERLAPPING,
        'You already have a leave request covering part of that window',
      );
    }

    // What this request COSTS, with weekends, public holidays and part-day ends applied — computed
    // once here and stored on the row, never recomputed. The holiday calendar is editable, so a
    // later addition inside a window someone already took would otherwise restate what their
    // approved leave cost.
    const workingDays = await this.balances.leaveCostFor(window);

    // Refuse before creating anything. A leave type with no entitlement row is untracked and
    // passes; a window of nothing but weekends is refused as a mistaken date range.
    await this.balances.assertSufficientBalance(
      actor.sub,
      input.leaveType,
      Number(input.startDate.slice(0, 4)),
      workingDays,
      undefined,
      // Accrual is judged as of the LAST day of the window: by the time these days are taken, will
      // they have been earned? Judging it today would refuse every advance booking.
      input.endDate,
    );

    // Create domain row first, then submit to engine
    const leave = await this.repo.createLeave({
      ...input,
      ...window,
      employeeId: actor.sub,
      workingDays,
    });

    const enginePayload: LeaveRequestPayload = {
      leaveRequestId: leave.id,
      employeeId: actor.sub,
      leaveType: leave.leaveType,
      startDate: leave.startDate,
      endDate: leave.endDate,
      startPortion: leave.startPortion,
      endPortion: leave.endPortion,
      // The cost travels with the request so an approver sees what they are approving: "2 days"
      // and "2 days minus an afternoon" are the same dates and a different decision.
      workingDays,
      reason: leave.reason,
    };
    const engineItem = await this.engine.submit('leave_request', enginePayload, actor, {
      expiresAt: new Date(Date.now() + 72 * MS_PER_HOUR), // 3-day review window
    });

    await this.db.transaction(async (tx) => {
      await this.repo.setLeaveRequestId(leave.id, engineItem.id, tx);
      await this.leaveTrail.record(AUDIT_ACTION.LEAVE_REQUESTED, leave.id, actor, tx, {
        after: {
          leaveType: leave.leaveType,
          startDate: leave.startDate,
          endDate: leave.endDate,
          startPortion: leave.startPortion,
          endPortion: leave.endPortion,
          workingDays,
          engineRequestId: engineItem.id,
        },
      });
    });
    return { ...leave, requestId: engineItem.id };
  }

  async getLeave(id: string): Promise<LeaveRequest> {
    const l = await this.repo.findLeaveById(id);
    if (!l)
      throw new NotFoundException(ErrorCodes.LEAVE_REQUEST_NOT_FOUND, 'Leave request not found');
    return l;
  }

  async listLeave(
    filters: LeaveFilters,
    limit: number,
    offset: number,
    actor: Actor,
  ): Promise<{ rows: LeaveRequest[]; total: number }> {
    return this.repo.listLeave(await this.narrowToActor(filters, actor), limit, offset);
  }

  async reviewLeave(id: string, approve: boolean, actor: Actor): Promise<LeaveRequest> {
    const l = await this.getLeave(id);
    if (l.status !== 'pending') {
      throw new PreconditionFailedException(
        ErrorCodes.LEAVE_REQUEST_NOT_PENDING,
        'Only pending leave requests can be reviewed',
      );
    }

    if (l.requestId) {
      if (approve) {
        await this.engine.approve(l.requestId, null, actor);
      } else {
        await this.engine.reject(l.requestId, null, actor);
      }
    } else {
      /*
       * PRE-ENGINE ROWS ONLY, and this branch is why the missing audit trail was invisible.
       *
       * `createLeave`/`createOvertime` set `requestId` on every row they make, so nothing reaching
       * this service today takes this path — only rows that predate the request engine can, and they
       * are the reason it is kept rather than deleted. But it holds the ONLY
       * `leave.approved` / `overtime.approved` writes in the service, so a reader (and a grep) saw
       * the decision being audited while the live path above recorded nothing at all. The entries now
       * live in the type-def hooks, where the engine applies the decision.
       */
      // Legacy path
      return this.db.transaction(async (tx) => {
        const updated = await this.repo.setLeaveStatus(
          id,
          approve ? 'approved' : 'rejected',
          actor.sub,
          tx,
        );
        await this.leaveTrail.record(
          approve ? AUDIT_ACTION.LEAVE_APPROVED : AUDIT_ACTION.LEAVE_REJECTED,
          id,
          actor,
          tx,
          { before: { status: l.status }, after: { status: approve ? 'approved' : 'rejected' } },
        );
        return updated!;
      });
    }

    return this.getLeave(id);
  }

  async cancelLeave(id: string, actor: Actor): Promise<LeaveRequest> {
    const l = await this.getLeave(id);
    await this.assertOwnerOrApprover(l.employeeId, actor);
    if (l.status !== 'pending' && l.status !== 'approved') {
      throw new PreconditionFailedException(
        ErrorCodes.LEAVE_REQUEST_NOT_PENDING,
        'Only pending or approved leave can be cancelled',
      );
    }
    const updated = await this.repo.setLeaveStatus(id, 'cancelled', null);
    return updated!;
  }

  // ── Overtime ───────────────────────────────────────────────────────────────
  async createOvertime(
    input: Omit<CreateOvertimeInput, 'employeeId'>,
    actor: Actor,
  ): Promise<OvertimeEntry> {
    const entry = await this.repo.createOvertime({ ...input, employeeId: actor.sub });

    const enginePayload: OvertimePayload = {
      overtimeId: entry.id,
      employeeId: actor.sub,
      workDate: entry.workDate,
      hours: input.hours,
      reason: entry.reason,
    };
    const engineItem = await this.engine.submit('overtime', enginePayload, actor, {
      expiresAt: new Date(Date.now() + 72 * MS_PER_HOUR), // 3-day review window
    });

    await this.repo.setOvertimeRequestId(entry.id, engineItem.id);

    return { ...entry, requestId: engineItem.id };
  }

  async getOvertime(id: string): Promise<OvertimeEntry> {
    const o = await this.repo.findOvertimeById(id);
    if (!o) throw new NotFoundException(ErrorCodes.OVERTIME_NOT_FOUND, 'Overtime entry not found');
    return o;
  }

  async listOvertime(
    filters: OvertimeFilters,
    limit: number,
    offset: number,
    actor: Actor,
  ): Promise<{ rows: OvertimeEntry[]; total: number }> {
    return this.repo.listOvertime(await this.narrowToActor(filters, actor), limit, offset);
  }

  async reviewOvertime(id: string, approve: boolean, actor: Actor): Promise<OvertimeEntry> {
    const o = await this.getOvertime(id);
    if (o.status !== 'pending') {
      throw new PreconditionFailedException(
        ErrorCodes.PRECONDITION_FAILED,
        'Only pending overtime entries can be reviewed',
      );
    }

    if (o.requestId) {
      if (approve) {
        await this.engine.approve(o.requestId, null, actor);
      } else {
        await this.engine.reject(o.requestId, null, actor);
      }
    } else {
      /*
       * PRE-ENGINE ROWS ONLY, and this branch is why the missing audit trail was invisible.
       *
       * `createLeave`/`createOvertime` set `requestId` on every row they make, so nothing reaching
       * this service today takes this path — only rows that predate the request engine can, and they
       * are the reason it is kept rather than deleted. But it holds the ONLY
       * `leave.approved` / `overtime.approved` writes in the service, so a reader (and a grep) saw
       * the decision being audited while the live path above recorded nothing at all. The entries now
       * live in the type-def hooks, where the engine applies the decision.
       */
      // Legacy path
      return this.db.transaction(async (tx) => {
        const updated = await this.repo.setOvertimeStatus(
          id,
          approve ? 'approved' : 'rejected',
          actor.sub,
          tx,
        );
        await this.overtimeTrail.record(
          approve ? AUDIT_ACTION.OVERTIME_APPROVED : AUDIT_ACTION.OVERTIME_REJECTED,
          id,
          actor,
          tx,
          { before: { status: o.status }, after: { status: approve ? 'approved' : 'rejected' } },
        );
        return updated!;
      });
    }

    return this.getOvertime(id);
  }

  // ── Shift logs ─────────────────────────────────────────────────────────────
  async createShiftLog(
    input: Omit<CreateShiftLogInput, 'employeeId'>,
    actor: Actor,
  ): Promise<ShiftLog> {
    if (input.startsAt >= input.endsAt) {
      throw new PreconditionFailedException(
        ErrorCodes.PRECONDITION_FAILED,
        'startsAt must be before endsAt',
      );
    }
    return this.repo.createShiftLog({ ...input, employeeId: actor.sub });
  }

  async getShiftLog(id: string): Promise<ShiftLog> {
    const s = await this.repo.findShiftLogById(id);
    if (!s) throw new NotFoundException(ErrorCodes.SHIFT_LOG_NOT_FOUND, 'Shift log not found');
    return s;
  }

  async listShiftLogs(
    filters: ShiftLogFilters,
    limit: number,
    offset: number,
    actor: Actor,
  ): Promise<{ rows: ShiftLog[]; total: number }> {
    return this.repo.listShiftLogs(await this.narrowToActor(filters, actor), limit, offset);
  }

  // ── Onboarding ─────────────────────────────────────────────────────────────

  /**
   * Submit a multi-step onboarding request for a new employee.
   * Steps: manager approve → IT provision → HR complete.
   * Returns the engine request ID so the caller can track progress.
   */
  async submitOnboarding(
    input: {
      employeeId: string;
      employeeEmail: string;
      startDate: string;
      department?: string;
      jobTitle?: string;
      managerName?: string;
      equipmentType?: string;
      preferredOs?: string;
      equipmentNote?: string;
      accessNeeds?: string[];
    },
    actor: Actor,
  ): Promise<string> {
    const payload: OnboardingPayload = {
      employeeId: input.employeeId,
      employeeEmail: input.employeeEmail,
      startDate: input.startDate,
      ...(input.department && { department: input.department }),
      ...(input.jobTitle && { jobTitle: input.jobTitle }),
      ...(input.managerName && { managerName: input.managerName }),
      ...(input.equipmentType && { equipmentType: input.equipmentType }),
      ...(input.preferredOs && { preferredOs: input.preferredOs }),
      ...(input.equipmentNote && { equipmentNote: input.equipmentNote }),
      ...(input.accessNeeds?.length && { accessNeeds: input.accessNeeds }),
    };
    const item = await this.engine.submit('onboarding', payload, actor);
    // No transaction of ours: `RequestEngine` owns the only write, and its row is the request.
    await this.employeeTrail.record(
      AUDIT_ACTION.ONBOARDING_SUBMITTED,
      input.employeeId,
      actor,
      undefined,
      { after: { requestId: item.id, startDate: input.startDate } },
    );
    return item.id;
  }

  // ── Offboarding ────────────────────────────────────────────────────────────

  /**
   * Submit an offboarding request for an employee.
   * On approval: status → offboarded, roles revoked, grants revoked,
   * assets returned, sessions invalidated — all atomically.
   */
  async submitOffboarding(
    input: { employeeId: string; employeeEmail: string; reason?: string },
    actor: Actor,
  ): Promise<string> {
    const payload: OffboardingPayload = {
      employeeId: input.employeeId,
      employeeEmail: input.employeeEmail,
      ...(input.reason && { reason: input.reason }),
    };
    const item = await this.engine.submit('offboarding', payload, actor);
    await this.employeeTrail.record(
      AUDIT_ACTION.OFFBOARDING_SUBMITTED,
      input.employeeId,
      actor,
      undefined,
      { after: { requestId: item.id, reason: input.reason } },
    );
    return item.id;
  }

  // ── Leave document upload ─────────────────────────────────────────────────

  /** Step 1 — returns a presigned S3 PUT URL for the client to upload to. */
  async presignLeaveDocument(
    leaveId: string,
    input: { fileName: string; mimeType: string; sizeBytes: number },
    actor: Actor,
  ): Promise<PresignUploadResult> {
    const leave = await this.repo.findLeaveById(leaveId);
    if (!leave)
      throw new NotFoundException(ErrorCodes.LEAVE_REQUEST_NOT_FOUND, 'Leave request not found');
    /*
     * THE OWNERSHIP CHECK THIS ROUTE PROMISED AND DID NOT MAKE.
     *
     * All three document routes are declared `@AuthorizedInService`, which tells PolicyGuard to stand
     * down because the service will decide — and the service decided nothing. The attachment on a
     * leave request is a medical certificate, so what that combination allowed was any authenticated
     * employee reading or replacing a colleague's sick note, using a leave id the list endpoint hands
     * out. The spec cited in the decorator as the pin does not contain the word "document".
     *
     * `assertOwnerOrApprover` is the same rule `cancelLeave` and `submitTimesheet` already use, so the
     * answer to "may I see this person's leave?" stays one answer across the module.
     */
    await this.assertOwnerOrApprover(leave.employeeId, actor);
    return this.storage.presignUpload(
      {
        fileName: input.fileName,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        resourceType: 'leave-document',
        linkedEntityType: 'leave_request',
        linkedEntityId: leaveId,
      },
      actor.sub,
    );
  }

  /** Step 3 — verify upload and link the S3 key to the leave request. */
  async confirmLeaveDocument(
    leaveId: string,
    fileId: string,
    actor: Actor,
  ): Promise<{ documentUrl: string }> {
    const leave = await this.repo.findLeaveById(leaveId);
    if (!leave)
      throw new NotFoundException(ErrorCodes.LEAVE_REQUEST_NOT_FOUND, 'Leave request not found');
    // Confirm REPLACES: it soft-deletes whatever was attached before. Overwriting somebody else's
    // certificate is the destructive half of the same hole.
    await this.assertOwnerOrApprover(leave.employeeId, actor);

    const result = await this.storage.confirmUpload(fileId, actor.sub);

    // Soft-delete old document if replaced
    if (leave.documentStorageKey) {
      const old = await this.storage.findByKey(leave.documentStorageKey);
      if (old) void this.storage.deleteFile(old.id, old.uploaderId);
    }

    await this.db.transaction(async (tx) => {
      await this.repo.updateLeaveDocument(leaveId, result.key, tx);
      await this.leaveTrail.record(AUDIT_ACTION.LEAVE_DOCUMENT_UPLOADED, leaveId, actor, tx, {});
    });

    return { documentUrl: result.url };
  }

  /**
   * A time-limited download URL for the leave supporting document.
   *
   * TAKES AN ACTOR, which is the whole point: this signature had no caller identity in it at all, so
   * no amount of care inside the method could have checked who was asking. A route whose guard has
   * been told to stand down and whose service cannot see the caller is unauthenticated in effect.
   */
  async getLeaveDocumentUrl(
    leaveId: string,
    actor: Actor,
  ): Promise<{ documentUrl: string | null }> {
    const leave = await this.repo.findLeaveById(leaveId);
    if (!leave)
      throw new NotFoundException(ErrorCodes.LEAVE_REQUEST_NOT_FOUND, 'Leave request not found');
    await this.assertOwnerOrApprover(leave.employeeId, actor);
    if (!leave.documentStorageKey) return { documentUrl: null };
    const url = await this.storage.presignGet(leave.documentStorageKey);
    return { documentUrl: url };
  }

  // ── Leave balances, entitlements, holidays ─────────────────────────────────

  /**
   * Balances for the caller, or for another employee with `workforce.read`.
   *
   * Narrowed through the SAME ActorScope rule as the leave list, so "can I see this person's
   * leave?" has one answer across the module rather than one per endpoint.
   *
   * `year` defaults here rather than in the DTO schema: a Zod default is evaluated when the module
   * loads, so a long-running process would keep serving last year's balances after New Year.
   */
  async listLeaveBalances(
    employeeId: string | undefined,
    year: number | undefined,
    actor: Actor,
  ): Promise<LeaveBalance[]> {
    const scoped = await this.narrowToActor({ employeeId }, actor);
    return this.balances.listBalances(
      scoped.employeeId ?? actor.sub,
      year ?? new Date().getUTCFullYear(),
    );
  }

  /**
   * Every leave policy, with the DEFAULT filled in for types that have none.
   *
   * Returns a row per leave type rather than only the configured ones, because "annual leave accrues
   * monthly" and "nobody has decided how sick leave accrues" are different answers and a screen
   * showing only three rows cannot tell them apart.
   */
  async listLeavePolicies(): Promise<
    {
      leaveType: LeaveType;
      accrualMethod: string;
      carryOverMaxDays: number;
      carryOverExpiryMonths: number | null;
      note: string | null;
      isDefault: boolean;
    }[]
  > {
    return this.balances.listPolicies();
  }

  /**
   * Bring unused days from `year - 1` into `year`.
   *
   * Wrapped in a transaction: it updates a row per employee per leave type, and a half-applied
   * carry-over would leave some people with next year's days and some without, with no way to tell
   * which from the rows themselves.
   */
  async runLeaveCarryOver(year: number, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const result = await this.balances.runCarryOver(year, tx);
      // Inside the transaction, so a run that commits days ALWAYS leaves the entry saying it did.
      // The entry is the only record of the run — nothing on the rows distinguishes days carried by
      // this run from days HR typed in — so an audit write that silently failed would make a bulk
      // change to everyone's balance untraceable.
      await this.entitlementTrail.record(
        AUDIT_ACTION.LEAVE_CARRY_OVER_RUN,
        String(year),
        actor,
        tx,
        {
          after: {
            year,
            applied: result.applied.length,
            skippedNoTargetRow: result.skippedNoTargetRow.length,
          },
        },
      );
      return result;
    });
  }

  async setLeaveEntitlement(
    input: {
      employeeId: string;
      leaveType: LeaveType;
      year: number;
      grantedDays: number;
      carriedOverDays?: number;
      note?: string;
    },
    actor: Actor,
  ): Promise<void> {
    // The employee's existence is checked by the CONTROLLER, which already injects
    // EmployeeService for the same reason on the leave routes. Doing it here would mean a second
    // path from this module into identity for one guard — and `leave_entitlements.employee_id`
    // carries no cross-schema FK, matching every other workforce table, so the check is the only
    // thing standing between a typo'd uuid and an orphan allowance.
    // Transactional, and the audit entry goes in with it. An allowance changes what every future
    // request of that type costs, so a grant recorded nowhere is exactly the gap a workforce audit
    // trail exists to close.
    await this.db.transaction(async (tx) => {
      await this.balances.setEntitlement(input, tx);
      await this.entitlementTrail.record(
        AUDIT_ACTION.LEAVE_ENTITLEMENT_SET,
        input.employeeId,
        actor,
        tx,
        {
          after: {
            leaveType: input.leaveType,
            year: input.year,
            grantedDays: input.grantedDays,
            carriedOverDays: input.carriedOverDays ?? 0,
          },
        },
      );
    });
  }

  async listHolidays(year: number | undefined) {
    return this.balances.listHolidays(year ?? new Date().getUTCFullYear());
  }

  async addHoliday(
    input: { date: string; name: string; region?: string },
    actor: Actor,
  ): Promise<{ id: string }> {
    return this.db.transaction(async (tx) => {
      const created = await this.balances.addHoliday(input, tx);
      await this.holidayTrail.record(AUDIT_ACTION.HOLIDAY_DECLARED, created.id, actor, tx, {
        after: { date: input.date, name: input.name, region: input.region ?? 'ALL' },
      });
      return created;
    });
  }

  async removeHoliday(id: string, actor: Actor): Promise<void> {
    await this.db.transaction(async (tx) => {
      const removed = await this.balances.removeHoliday(id, tx);
      if (!removed) {
        // Thrown inside the transaction so the audit entry below cannot describe a deletion that
        // did not happen — the throw rolls both back together.
        throw new NotFoundException(ErrorCodes.NOT_FOUND, `Holiday ${id} not found`);
      }
      await this.holidayTrail.record(AUDIT_ACTION.HOLIDAY_REMOVED, id, actor, tx, {});
    });
  }
}
