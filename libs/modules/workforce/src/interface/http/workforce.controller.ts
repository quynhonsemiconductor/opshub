import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  ApiCommonErrors,
  ApiPagedResponse,
  Auth,
  AuthorizedInService,
  CurrentUser,
  RateLimit,
  RequirePermission,
  SelfScoped,
  SharedRead,
  buildPageResult,
} from '@platform';
import type { JwtPayload, PagedResult } from '@platform';
import { EmployeeService } from '@modules/identity';
import { AuditService, AUDIT_ACTION, AUDIT_RESOURCE } from '@modules/audit';
import { WorkforceService } from '../../application/workforce.service';
import {
  CreateHolidayDto,
  HolidayQueryDto,
  HolidayResponseDto,
  LeaveBalanceQueryDto,
  CarryOverResultResponseDto,
  LeaveBalanceResponseDto,
  LeavePolicyResponseDto,
  RunCarryOverDto,
  SetLeaveEntitlementDto,
  CreateTimesheetDto,
  BulkCreateTimesheetsDto,
  ListTimesheetsQueryDto,
  TimesheetResponseDto,
  CreateLeaveDto,
  ListLeaveQueryDto,
  LeaveResponseDto,
  CreateOvertimeDto,
  ListOvertimeQueryDto,
  OvertimeResponseDto,
  CreateShiftLogDto,
  ListShiftLogsQueryDto,
  ShiftLogResponseDto,
  ReviewDto,
  SubmitOnboardingDto,
  OnboardingResponseDto,
  SubmitOffboardingDto,
  OffboardingResponseDto,
  PresignLeaveDocumentDto,
  ConfirmLeaveDocumentDto,
} from './dto/workforce.dto';
import type {
  LeaveRequest,
  OvertimeEntry,
  ShiftLog,
  Timesheet,
} from '../../domain/workforce.types';

function toTimesheetDto(t: Timesheet): TimesheetResponseDto {
  return {
    id: t.id,
    employeeId: t.employeeId,
    workDate: t.workDate,
    minutesWorked: t.minutesWorked,
    note: t.note,
    status: t.status,
    submittedAt: t.submittedAt ? t.submittedAt.toISOString() : null,
    approvedBy: t.approvedBy,
    createdAt: t.createdAt.toISOString(),
  };
}

function toLeaveDto(l: LeaveRequest): LeaveResponseDto {
  return {
    id: l.id,
    employeeId: l.employeeId,
    leaveType: l.leaveType,
    startDate: l.startDate,
    endDate: l.endDate,
    startPortion: l.startPortion,
    endPortion: l.endPortion,
    reason: l.reason,
    // numeric(5,2) arrives from the driver as a string; the API contract is a number.
    workingDays:
      l.workingDays === null || l.workingDays === undefined ? null : Number(l.workingDays),
    status: l.status,
    reviewerId: l.reviewerId,
    reviewedAt: l.reviewedAt ? l.reviewedAt.toISOString() : null,
    createdAt: l.createdAt.toISOString(),
  };
}

function toOvertimeDto(o: OvertimeEntry): OvertimeResponseDto {
  return {
    id: o.id,
    employeeId: o.employeeId,
    workDate: o.workDate,
    hours: o.hours,
    reason: o.reason,
    status: o.status,
    reviewerId: o.reviewerId,
    reviewedAt: o.reviewedAt ? o.reviewedAt.toISOString() : null,
    createdAt: o.createdAt.toISOString(),
  };
}

function toShiftLogDto(s: ShiftLog): ShiftLogResponseDto {
  return {
    id: s.id,
    employeeId: s.employeeId,
    shiftType: s.shiftType,
    startsAt: s.startsAt.toISOString(),
    endsAt: s.endsAt.toISOString(),
    note: s.note,
    createdAt: s.createdAt.toISOString(),
  };
}

@ApiTags('workforce')
@Controller('workforce')
@Auth()
export class WorkforceController {
  constructor(
    private readonly service: WorkforceService,
    private readonly audit: AuditService,
    private readonly employeeService: EmployeeService,
  ) {}

  // ── Timesheets ─────────────────────────────────────────────────────────────
  @Get('timesheets')
  @AuthorizedInService(
    'optional employeeId filter: narrowToActor denies asking for another employee without workforce.read, else pins it to user.sub',
    'workforce-access-narrowing.spec.ts',
  )
  @ApiOperation({
    summary: 'List timesheets',
    description:
      'Narrowed to the caller unless they hold `workforce.read` globally. Requesting ' +
      "another employee's records without it is a 403, not an empty page.",
  })
  @ApiPagedResponse(TimesheetResponseDto)
  @ApiCommonErrors(401, 403)
  async listTimesheets(
    @Query() query: ListTimesheetsQueryDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<PagedResult<TimesheetResponseDto>> {
    const { rows, total } = await this.service.listTimesheets(
      {
        employeeId: query.employeeId,
        status: query.status,
        dateFrom: query.dateFrom,
        dateTo: query.dateTo,
      },
      query.limit,
      query.offset,
      user,
    );
    return buildPageResult(rows.map(toTimesheetDto), total, query.limit, query.offset);
  }

  @Post('timesheets')
  @SelfScoped('creates a timesheet FOR the caller — employeeId is actor.sub')
  @ApiOperation({ summary: 'Create a draft timesheet for the current user' })
  @ApiCommonErrors(401, 422)
  async createTimesheet(
    @Body() dto: CreateTimesheetDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<TimesheetResponseDto> {
    const ts = await this.service.createTimesheet(dto, user);
    void this.audit.record({
      actorId: user.sub,
      actorEmail: user.email,
      action: AUDIT_ACTION.TIMESHEET_CREATED,
      resourceType: AUDIT_RESOURCE.TIMESHEET,
      resourceId: ts.id,
      metadata: { workDate: dto.workDate, minutesWorked: dto.minutesWorked },
    });
    return toTimesheetDto(ts);
  }

  /**
   * Up to 50 drafts in one call. Every entry is validated by the SAME schema as a single create —
   * start/end derivation included — and the batch is ALL-OR-NOTHING: one bad entry fails all of
   * them (422 at validation, a rolled-back insert at persistence), never a partial week the
   * caller would have to diff against their source to discover.
   */
  @Post('timesheets/bulk')
  @SelfScoped('creates timesheets FOR the caller — employeeId is actor.sub on every entry')
  @ApiOperation({ summary: 'Create draft timesheets in bulk (max 50, all-or-nothing)' })
  @ApiCreatedResponse({ type: [TimesheetResponseDto] })
  @ApiCommonErrors(401, 422)
  async createTimesheetsBulk(
    @Body() dto: BulkCreateTimesheetsDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<TimesheetResponseDto[]> {
    const created = await this.service.createTimesheetsBulk(dto.entries, user);
    // One entry per row, with the same action as a single create, so the trail stays queryable
    // per timesheet no matter which route made it.
    for (const ts of created) {
      void this.audit.record({
        actorId: user.sub,
        actorEmail: user.email,
        action: AUDIT_ACTION.TIMESHEET_CREATED,
        resourceType: AUDIT_RESOURCE.TIMESHEET,
        resourceId: ts.id,
        metadata: { workDate: ts.workDate, minutesWorked: ts.minutesWorked },
      });
    }
    return created.map(toTimesheetDto);
  }

  @Post('timesheets/:id/submit')
  @AuthorizedInService(
    'assertOwnerOrApprover: the owner, or a holder of workforce.approve',
    'workforce-access-narrowing.spec.ts',
  )
  @ApiOperation({
    summary: 'Submit a timesheet for approval',
    description:
      'The owner submits their own timesheet. `workforce.approve` held globally also ' +
      'permits it, for HR acting on an employee behalf.',
  })
  @ApiCommonErrors(401, 403, 404, 412)
  async submitTimesheet(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<TimesheetResponseDto> {
    const ts = await this.service.submitTimesheet(id, user);
    void this.audit.record({
      actorId: user.sub,
      actorEmail: user.email,
      action: AUDIT_ACTION.TIMESHEET_SUBMITTED,
      resourceType: AUDIT_RESOURCE.TIMESHEET,
      resourceId: id,
    });
    return toTimesheetDto(ts);
  }

  @Post('timesheets/:id/review')
  @RequirePermission('workforce.approve')
  @ApiOperation({ summary: 'Approve or reject a timesheet' })
  @ApiCommonErrors(401, 403, 404, 412)
  async reviewTimesheet(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<TimesheetResponseDto> {
    const ts = await this.service.reviewTimesheet(id, dto.approve, user);
    return toTimesheetDto(ts);
  }

  // ── Leave ──────────────────────────────────────────────────────────────────
  @Get('leave')
  @AuthorizedInService(
    'optional employeeId filter — see narrowToActor',
    'workforce-access-narrowing.spec.ts',
  )
  @ApiOperation({
    summary: 'List leave requests',
    description:
      'Narrowed to the caller unless they hold `workforce.read` globally. Requesting ' +
      "another employee's records without it is a 403, not an empty page.",
  })
  @ApiPagedResponse(LeaveResponseDto)
  @ApiCommonErrors(401, 403)
  async listLeave(
    @Query() query: ListLeaveQueryDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<PagedResult<LeaveResponseDto>> {
    const { rows, total } = await this.service.listLeave(
      {
        employeeId: query.employeeId,
        status: query.status,
        dateFrom: query.dateFrom,
        dateTo: query.dateTo,
      },
      query.limit,
      query.offset,
      user,
    );
    return buildPageResult(rows.map(toLeaveDto), total, query.limit, query.offset);
  }

  @Post('leave')
  @SelfScoped('files leave FOR the caller — employeeId is actor.sub')
  @ApiOperation({
    summary: 'Request leave for the current user',
    description:
      'Whole days by default. For part-day leave set `startPortion` / `endPortion`: a lone ' +
      '`morning` or `afternoon` on a single day costs 0.5, and a window may begin in the ' +
      '`afternoon` and end with a `morning` — Wednesday afternoon to Friday morning is 2 days. ' +
      'A whole day is `full_day`, never morning-to-afternoon, and a multi-day window cannot ' +
      'start with a lone morning or end with a lone afternoon (412 `LEAVE_INVALID_WINDOW`). ' +
      'A part-day end falling on a weekend or public holiday costs nothing, because the day it ' +
      'is half of costs nothing. Two requests sharing a date but not a half-day do NOT conflict.',
  })
  @ApiCommonErrors(401, 409, 412, 422)
  async createLeave(
    @Body() dto: CreateLeaveDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<LeaveResponseDto> {
    const leave = await this.service.createLeave(dto, user);
    return toLeaveDto(leave);
  }

  @Post('leave/:id/review')
  @RequirePermission('workforce.approve')
  @ApiOperation({ summary: 'Approve or reject a leave request' })
  @ApiCommonErrors(401, 403, 404, 412)
  async reviewLeave(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<LeaveResponseDto> {
    const leave = await this.service.reviewLeave(id, dto.approve, user);
    return toLeaveDto(leave);
  }

  @Post('leave/:id/cancel')
  @AuthorizedInService(
    'assertOwnerOrApprover: the owner, or a holder of workforce.approve',
    'workforce-access-narrowing.spec.ts',
  )
  @ApiOperation({
    summary: 'Cancel a leave request',
    description:
      'The requester withdraws their own leave. `workforce.approve` held globally also ' +
      'permits it, for HR acting on an employee behalf.',
  })
  @ApiCommonErrors(401, 403, 404, 412)
  async cancelLeave(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<LeaveResponseDto> {
    const leave = await this.service.cancelLeave(id, user);
    void this.audit.record({
      actorId: user.sub,
      actorEmail: user.email,
      action: AUDIT_ACTION.LEAVE_CANCELLED,
      resourceType: AUDIT_RESOURCE.LEAVE_REQUEST,
      resourceId: id,
    });
    return toLeaveDto(leave);
  }

  // ── Overtime ───────────────────────────────────────────────────────────────
  @Get('overtime')
  @AuthorizedInService(
    'optional employeeId filter — see narrowToActor',
    'workforce-access-narrowing.spec.ts',
  )
  @ApiOperation({
    summary: 'List overtime entries',
    description:
      'Narrowed to the caller unless they hold `workforce.read` globally. Requesting ' +
      "another employee's records without it is a 403, not an empty page.",
  })
  @ApiPagedResponse(OvertimeResponseDto)
  @ApiCommonErrors(401, 403)
  async listOvertime(
    @Query() query: ListOvertimeQueryDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<PagedResult<OvertimeResponseDto>> {
    const { rows, total } = await this.service.listOvertime(
      {
        employeeId: query.employeeId,
        status: query.status,
        dateFrom: query.dateFrom,
        dateTo: query.dateTo,
      },
      query.limit,
      query.offset,
      user,
    );
    return buildPageResult(rows.map(toOvertimeDto), total, query.limit, query.offset);
  }

  @Post('overtime')
  @SelfScoped('logs overtime FOR the caller — employeeId is actor.sub')
  @ApiOperation({ summary: 'Log overtime for the current user' })
  @ApiCommonErrors(401, 422)
  async createOvertime(
    @Body() dto: CreateOvertimeDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<OvertimeResponseDto> {
    const entry = await this.service.createOvertime(dto, user);
    void this.audit.record({
      actorId: user.sub,
      actorEmail: user.email,
      action: AUDIT_ACTION.OVERTIME_LOGGED,
      resourceType: AUDIT_RESOURCE.OVERTIME_ENTRY,
      resourceId: entry.id,
      metadata: { workDate: dto.workDate, hours: dto.hours },
    });
    return toOvertimeDto(entry);
  }

  @Post('overtime/:id/review')
  @RequirePermission('workforce.approve')
  @ApiOperation({ summary: 'Approve or reject an overtime entry' })
  @ApiCommonErrors(401, 403, 404, 412)
  async reviewOvertime(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<OvertimeResponseDto> {
    const entry = await this.service.reviewOvertime(id, dto.approve, user);
    return toOvertimeDto(entry);
  }

  // ── Shift logs ─────────────────────────────────────────────────────────────
  @Get('shifts')
  @AuthorizedInService(
    'optional employeeId filter — see narrowToActor',
    'workforce-access-narrowing.spec.ts',
  )
  @ApiOperation({
    summary: 'List night/on-call/weekend shift logs',
    description:
      'Narrowed to the caller unless they hold `workforce.read` globally. Requesting ' +
      "another employee's records without it is a 403, not an empty page.",
  })
  @ApiPagedResponse(ShiftLogResponseDto)
  @ApiCommonErrors(401, 403)
  async listShifts(
    @Query() query: ListShiftLogsQueryDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<PagedResult<ShiftLogResponseDto>> {
    const { rows, total } = await this.service.listShiftLogs(
      { employeeId: query.employeeId, shiftType: query.shiftType },
      query.limit,
      query.offset,
      user,
    );
    return buildPageResult(rows.map(toShiftLogDto), total, query.limit, query.offset);
  }

  @Post('shifts')
  @SelfScoped('logs a shift FOR the caller — employeeId is actor.sub')
  @ApiOperation({ summary: 'Log a worked shift for the current user' })
  @ApiCommonErrors(401, 412, 422)
  async createShift(
    @Body() dto: CreateShiftLogDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<ShiftLogResponseDto> {
    const shift = await this.service.createShiftLog(
      { ...dto, startsAt: new Date(dto.startsAt), endsAt: new Date(dto.endsAt) },
      user,
    );
    void this.audit.record({
      actorId: user.sub,
      actorEmail: user.email,
      action: AUDIT_ACTION.SHIFT_LOGGED,
      resourceType: AUDIT_RESOURCE.SHIFT_LOG,
      resourceId: shift.id,
      metadata: { shiftType: dto.shiftType, startsAt: dto.startsAt, endsAt: dto.endsAt },
    });
    return toShiftLogDto(shift);
  }

  // ── Onboarding ─────────────────────────────────────────────────────────────

  @Post('onboarding')
  @RequirePermission('onboarding.approve')
  @ApiOperation({ summary: 'Submit a 3-step onboarding request for a new employee' })
  @ApiResponse({ status: 201, type: OnboardingResponseDto })
  @ApiCommonErrors(400, 401, 403, 404)
  async submitOnboarding(
    @Body() dto: SubmitOnboardingDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<OnboardingResponseDto> {
    const employee = await this.employeeService.getById(dto.employeeId);
    const requestId = await this.service.submitOnboarding(
      {
        employeeId: employee.id,
        employeeEmail: employee.email,
        startDate: dto.startDate,
        department: dto.department,
        jobTitle: dto.jobTitle,
        managerName: dto.managerName,
        equipmentType: dto.equipmentType,
        preferredOs: dto.preferredOs,
        equipmentNote: dto.equipmentNote,
        accessNeeds: dto.accessNeeds,
      },
      user,
    );
    return { requestId };
  }

  // ── Offboarding ────────────────────────────────────────────────────────────

  @Post('offboarding')
  @RequirePermission('offboarding.approve')
  @ApiOperation({ summary: 'Submit an offboarding request — revokes all access on approval' })
  @ApiResponse({ status: 201, type: OffboardingResponseDto })
  @ApiCommonErrors(400, 401, 403, 404)
  async submitOffboarding(
    @Body() dto: SubmitOffboardingDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<OffboardingResponseDto> {
    const employee = await this.employeeService.getById(dto.employeeId);
    const requestId = await this.service.submitOffboarding(
      {
        employeeId: employee.id,
        employeeEmail: employee.email,
        reason: dto.reason,
      },
      user,
    );
    return { requestId };
  }

  // ── Leave document upload ─────────────────────────────────────────────

  // UPLOAD tier: a presign hands out a signed PUT and a confirm does a HeadObject, so both cost S3
  // requests rather than just database time. Assets carried this from the start; these three surfaces
  // did not, which meant the tier existed and two thirds of the uploads in the product ignored it.
  @RateLimit('UPLOAD')
  @Post('leave-requests/:id/document/presign')
  // 200, not Nest's default 201: this is not a creation, and the `@ApiResponse` below already promises
  // 200 — so without this the generated client's contract disagreed with the server. The asset-photo and
  // avatar upload routes carry the same line for the same reason; these two were missed, and a browser
  // spec asserting the documented status is what found it.
  @HttpCode(HttpStatus.OK)
  @AuthorizedInService(
    'assertOwnerOrApprover on the leave request the document attaches to',
    'leave-document-access.e2e.spec.ts',
  )
  @ApiOperation({
    summary:
      'Get a presigned S3 PUT URL to upload a leave supporting document (e.g. medical certificate)',
  })
  @ApiResponse({
    status: 200,
    schema: {
      properties: {
        fileId: { type: 'string' },
        uploadUrl: { type: 'string' },
        key: { type: 'string' },
      },
      required: ['fileId', 'uploadUrl', 'key'],
    },
  })
  @ApiCommonErrors(401, 404, 422)
  async presignLeaveDocument(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PresignLeaveDocumentDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.presignLeaveDocument(id, dto, user);
  }

  @RateLimit('UPLOAD')
  @Post('leave-requests/:id/document/confirm')
  // 200, not Nest's default 201: this is not a creation, and the `@ApiResponse` below already promises
  // 200 — so without this the generated client's contract disagreed with the server. The asset-photo and
  // avatar upload routes carry the same line for the same reason; these two were missed, and a browser
  // spec asserting the documented status is what found it.
  @HttpCode(HttpStatus.OK)
  @AuthorizedInService(
    'assertOwnerOrApprover on the owning leave request',
    'leave-document-access.e2e.spec.ts',
  )
  @ApiOperation({ summary: 'Confirm leave document upload completed' })
  @ApiResponse({
    status: 200,
    schema: { properties: { documentUrl: { type: 'string' } }, required: ['documentUrl'] },
  })
  @ApiCommonErrors(401, 404, 422)
  async confirmLeaveDocument(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmLeaveDocumentDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.confirmLeaveDocument(id, dto.fileId, user);
  }

  @Get('leave-requests/:id/document')
  @AuthorizedInService(
    'assertOwnerOrApprover on the owning leave request',
    'leave-document-access.e2e.spec.ts',
  )
  @ApiOperation({ summary: 'Get a time-limited download URL for the leave supporting document' })
  @ApiResponse({
    status: 200,
    schema: {
      properties: { documentUrl: { type: 'string', nullable: true } },
      required: ['documentUrl'],
    },
  })
  // 403 joins the list: reading somebody else's certificate is refused, not merely unlisted.
  @ApiCommonErrors(401, 403, 404)
  async getLeaveDocumentUrl(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.getLeaveDocumentUrl(id, user);
  }

  // ── Leave balances, entitlements and the holiday calendar ───────────────────

  /**
   * The caller's leave balances, or another employee's with `workforce.read`.
   *
   * Reuses the same narrowing rule as the leave list: asking for someone else without the
   * permission is a 403, never a silently substituted set of your own numbers.
   */
  @Get('leave/balance')
  @AuthorizedInService(
    'optional employeeId — narrowed to the actor without workforce.read',
    'leave-balance.e2e.spec.ts',
  )
  @ApiOperation({
    summary: 'Leave balances for a year',
    description:
      '`availableDays` is what may be booked now — accrued so far, plus unexpired carried days, ' +
      'minus consumed — and it is the figure the balance check enforces. `remainingDays` is what the ' +
      'year settles at (granted + carried − consumed) and is the larger number whenever the year is ' +
      'part-accrued or carried days have lapsed. Consumed counts APPROVED and still-PENDING ' +
      'requests. A leave type with no entitlement row is untracked and absent from the result.',
  })
  @ApiOkResponse({ type: [LeaveBalanceResponseDto] })
  @ApiCommonErrors(401, 403)
  async listLeaveBalances(
    @Query() query: LeaveBalanceQueryDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<LeaveBalanceResponseDto[]> {
    return this.service.listLeaveBalances(query.employeeId, query.year, user);
  }

  /** Declare an employee's allowance for a leave type and year. */
  @Put('leave/entitlement')
  @RequirePermission('workforce.manage')
  @ApiOperation({
    summary: 'Set an annual leave entitlement',
    description:
      'Upsert: an allowance is corrected more often than created (a mid-year joiner, a policy ' +
      'change), so a second call updates rather than conflicting.',
  })
  @ApiNoContentResponse()
  @HttpCode(204)
  @ApiCommonErrors(401, 403, 422)
  async setLeaveEntitlement(
    @Body() dto: SetLeaveEntitlementDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<void> {
    // Refuse an allowance for an employee who does not exist: the table carries no cross-schema
    // FK (matching every other workforce table), so a typo'd uuid would otherwise become an
    // orphan row that no screen can show and no balance can use.
    await this.employeeService.assertExist(dto.employeeId);
    await this.service.setLeaveEntitlement(dto, user);
  }

  /** How each leave type accrues, and what it carries over. */
  @Get('leave/policies')
  @RequirePermission('workforce.read')
  @ApiOperation({
    summary: 'Leave accrual and carry-over policy per type',
    description:
      'One row per leave type. `isDefault` marks a type with NO policy row, which behaves as every ' +
      'entitlement did before accrual existed — available in full from 1 January, nothing carried. ' +
      'That default is a MEANING, not a gap: `unpaid` and `other` are untracked, so a policy for ' +
      'them would govern nothing.',
  })
  @ApiOkResponse({ type: [LeavePolicyResponseDto] })
  @ApiCommonErrors(401, 403)
  async listLeavePolicies(): Promise<LeavePolicyResponseDto[]> {
    return this.service.listLeavePolicies();
  }

  /**
   * Bring last year's unused days forward.
   *
   * `workforce.manage` and not `workforce.approve`: this sets what every employee may take next year,
   * which is the same blast radius as declaring a public holiday or setting an allowance — and
   * distinctly not the same act as deciding one person's request.
   */
  @Post('leave/carry-over')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('workforce.manage')
  @ApiOperation({
    summary: 'Carry unused days from the previous year into this one',
    description:
      "IDEMPOTENT: it SETS each carried figure from the previous year's closing balance rather than " +
      'adding to it, so a second run — or a run after a late correction to last year — lands on the ' +
      'same answer. Capped per type by the policy, and stamped with the date the carried days lapse. ' +
      'Employees with days to carry but no entitlement row for the target year are REPORTED, not ' +
      "given a row with a zero grant: the new year's allowance is HR's decision, not this run's.",
  })
  @ApiOkResponse({ type: CarryOverResultResponseDto })
  @ApiCommonErrors(400, 401, 403, 422)
  async runLeaveCarryOver(
    @Body() dto: RunCarryOverDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<CarryOverResultResponseDto> {
    return this.service.runLeaveCarryOver(dto.year, user);
  }

  @Get('holidays')
  @SharedRead('the public holiday calendar is unowned reference data every employee needs')
  @ApiOperation({ summary: 'Public holidays for a year' })
  @ApiOkResponse({ type: [HolidayResponseDto] })
  @ApiCommonErrors(401)
  async listHolidays(@Query() query: HolidayQueryDto): Promise<HolidayResponseDto[]> {
    return this.service.listHolidays(query.year);
  }

  @Post('holidays')
  @RequirePermission('workforce.manage')
  @ApiOperation({
    summary: 'Declare a public holiday',
    description:
      'Does NOT change what existing requests cost — working_days is frozen per request at ' +
      'submit, so leave already approved keeps the charge it was approved with.',
  })
  @ApiCreatedResponse({ type: HolidayResponseDto })
  @ApiCommonErrors(401, 403, 422)
  async addHoliday(
    @Body() dto: CreateHolidayDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<{ id: string }> {
    return this.service.addHoliday(dto, user);
  }

  @Delete('holidays/:id')
  @RequirePermission('workforce.manage')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a public holiday' })
  @ApiNoContentResponse()
  @ApiCommonErrors(401, 403, 404)
  async removeHoliday(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<void> {
    await this.service.removeHoliday(id, user);
  }
}
