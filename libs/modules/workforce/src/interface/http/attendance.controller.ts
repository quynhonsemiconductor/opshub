import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiCommonErrors,
  Auth,
  AuthorizedInService,
  CurrentUser,
  RequirePermission,
  SelfScoped,
} from '@platform';
import type { JwtPayload } from '@platform';
import { AttendanceService, type MonthClose } from '../../application/attendance.service';
import type { AttendanceJustificationPayload } from '../../application/attendance-justification.type-def';
import {
  AttendanceMonthQueryDto,
  AttendanceMonthResponseDto,
  CloseMonthDto,
  CreateJustificationDto,
  JustificationPreviewQueryDto,
  JustificationPreviewResponseDto,
  JustificationResponseDto,
  ListJustificationsQueryDto,
  MonthCloseParamDto,
  MyAttendanceMonthQueryDto,
  ReopenMonthDto,
} from './dto/attendance.dto';
import { ReviewDto } from './dto/workforce.dto';

type JustificationRow = {
  id: string;
  employeeId: string;
  startDate: string;
  endDate: string;
  kind: AttendanceJustificationPayload['kind'];
  reason: string | null;
  workingDays: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  reviewerId: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
  requestId: string | null;
};

function toJustificationDto(j: JustificationRow): JustificationResponseDto {
  return {
    id: j.id,
    employeeId: j.employeeId,
    startDate: j.startDate,
    endDate: j.endDate,
    kind: j.kind,
    reason: j.reason,
    // numeric(5,2) arrives from the driver as a string; the API contract is a number.
    workingDays: Number(j.workingDays),
    status: j.status,
    reviewerId: j.reviewerId,
    reviewedAt: j.reviewedAt ? j.reviewedAt.toISOString() : null,
    createdAt: j.createdAt.toISOString(),
  };
}

function toCloseDto(close: MonthClose | null) {
  if (!close) return null;
  return {
    month: close.month,
    closedBy: close.closedBy,
    closedAt: close.closedAt.toISOString(),
    note: close.note,
  };
}

/**
 * Attendance: the DERIVED month view (nothing per day is stored), justification requests, and the
 * month close.
 *
 * The door schema is read here and only read — this module never writes to it.
 */
@ApiTags('workforce')
@Controller('workforce/attendance')
@Auth()
export class AttendanceController {
  constructor(private readonly service: AttendanceService) {}

  @Get()
  @AuthorizedInService(
    'scope decided in service: workforce.attendance.read sees all, a manager sees self + direct ' +
      'reports, and asking for anyone outside that is a 403',
    'attendance-access-narrowing.spec.ts',
  )
  @ApiOperation({
    summary: 'The derived attendance month',
    description:
      'Status, worked minutes and flags per WORKING day, computed from the door swipes plus the ' +
      'live leave, WFH and justification requests — never stored. Ladder: holiday > full-day leave ' +
      '> approved WFH > office swipes > absent.',
  })
  @ApiOkResponse({ type: AttendanceMonthResponseDto })
  @ApiCommonErrors(401, 403, 422)
  async getMonth(
    @Query() query: AttendanceMonthQueryDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<AttendanceMonthResponseDto> {
    const month = await this.service.getMonth(query.month, user, query.employeeId);
    return { ...month, close: toCloseDto(month.close) };
  }

  @Get('me')
  @SelfScoped("the CALLER's own month — the employee is actor.sub, never a parameter")
  @ApiOperation({ summary: "The caller's own derived attendance month" })
  @ApiOkResponse({ type: AttendanceMonthResponseDto })
  @ApiCommonErrors(401, 422)
  async getMyMonth(
    @Query() query: MyAttendanceMonthQueryDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<AttendanceMonthResponseDto> {
    const month = await this.service.getMyMonth(query.month, user);
    return { ...month, close: toCloseDto(month.close) };
  }

  @Get('justifications/preview')
  @SelfScoped("previews the CALLER's own window — no employee parameter exists")
  @ApiOperation({ summary: 'What a justification window covers, before filing it' })
  @ApiOkResponse({ type: JustificationPreviewResponseDto })
  @ApiCommonErrors(401, 422)
  async preview(
    @Query() query: JustificationPreviewQueryDto,
  ): Promise<JustificationPreviewResponseDto> {
    return this.service.previewJustification(query.startDate, query.endDate);
  }

  @Get('justifications')
  @AuthorizedInService(
    'optional employeeId filter — attendance.access narrowing (self + team without attendance.read)',
    'attendance-access-narrowing.spec.ts',
  )
  @ApiOperation({ summary: 'List attendance justifications' })
  @ApiOkResponse({ type: [JustificationResponseDto] })
  @ApiCommonErrors(401, 403)
  async listJustifications(
    @Query() query: ListJustificationsQueryDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<JustificationResponseDto[]> {
    const rows = await this.service.listJustifications(query, user);
    return rows.map(toJustificationDto);
  }

  @Post('justifications')
  @SelfScoped('files a justification FOR the caller — employeeId is actor.sub')
  @ApiOperation({
    summary: 'File an attendance justification for the current user',
    description:
      'A date range expanded to working days, approved or rejected as a whole. No overlap rule: a ' +
      'justification explains days (late/early/forgot_card/missing_checkout), it does not spend ' +
      'them. Refused with 412 ATTENDANCE_MONTH_CLOSED when the month has been closed.',
  })
  @ApiCreatedResponse({ type: JustificationResponseDto })
  @ApiCommonErrors(401, 412, 422)
  async createJustification(
    @Body() dto: CreateJustificationDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<JustificationResponseDto> {
    const row = await this.service.createJustification(dto, user);
    return toJustificationDto(row);
  }

  @Post('justifications/:id/review')
  // Row-scoped like the workforce review routes (sibling-agreement ratchet); the engine still
  // checks `workforce.attendance.review` and separation of duties.
  @RequirePermission('workforce.approve', {
    resource: 'attendance_justification',
    from: 'param',
    field: 'id',
  })
  @ApiOperation({ summary: 'Approve or reject a justification' })
  @ApiCommonErrors(401, 403, 404, 412)
  async reviewJustification(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<JustificationResponseDto> {
    const row = await this.service.reviewJustification(id, dto.approve, user);
    return toJustificationDto(row);
  }

  @Post('justifications/:id/cancel')
  @AuthorizedInService(
    'the requester withdraws their own pending justification',
    'attendance-access-narrowing.spec.ts',
  )
  @ApiOperation({ summary: 'Withdraw a pending justification' })
  @ApiCommonErrors(401, 403, 404, 412)
  async cancelJustification(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<JustificationResponseDto> {
    const row = await this.service.cancelJustification(id, user);
    return toJustificationDto(row);
  }

  @Post('months/:month/close')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('workforce.attendance.close', {
    resource: 'attendance_month',
    from: 'param',
    field: 'month',
  })
  @ApiOperation({
    summary: 'Close an attendance month',
    description:
      'Locks the month: no new leave, WFH or justification whose window touches it, no decision on ' +
      'a pending one, no cancellation. Reopening is the audited administrator override.',
  })
  @ApiOkResponse({ type: AttendanceMonthResponseDto })
  @ApiCommonErrors(401, 403, 409, 422)
  async closeMonth(
    @Param() params: MonthCloseParamDto,
    @Body() dto: CloseMonthDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const close = await this.service.closeMonth(params.month, user, dto.note);
    return {
      month: close.month,
      closedBy: close.closedBy,
      closedAt: close.closedAt.toISOString(),
      note: close.note,
    };
  }

  @Post('months/:month/reopen')
  @HttpCode(HttpStatus.OK)
  // Granted to NO role: only the admin wildcard reaches this route — the override is by definition
  // not routine, and the audit entry carries the mandatory reason.
  @RequirePermission('workforce.attendance.reopen', {
    resource: 'attendance_month',
    from: 'param',
    field: 'month',
  })
  @ApiOperation({ summary: 'Reopen a closed month — the audited administrator override' })
  @ApiCommonErrors(401, 403, 404, 412, 422)
  async reopenMonth(
    @Param() params: MonthCloseParamDto,
    @Body() dto: ReopenMonthDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<{ month: string; reopened: true }> {
    await this.service.reopenMonth(params.month, user, dto.note);
    return { month: params.month, reopened: true };
  }
}
