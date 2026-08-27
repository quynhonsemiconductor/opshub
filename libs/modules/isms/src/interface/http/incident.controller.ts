import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiCommonErrors,
  ApiPagedResponse,
  Auth,
  AuthorizedInService,
  CurrentUser,
  RequirePermission,
  buildPageResult,
  type JwtPayload,
  type PagedResult,
} from '@platform';
import { EmployeeService } from '@modules/identity';
import { BREACH_NOTIFICATION_HOURS, IncidentService } from '../../application/incident.service';
import type { Incident, IncidentEvent, OverdueBreach } from '../../domain/incident.types';
import {
  CloseIncidentDto,
  ContainIncidentDto,
  DismissIncidentDto,
  IncidentEventResponseDto,
  IncidentResponseDto,
  ListIncidentsQueryDto,
  NotifyRegulatorDto,
  OverdueBreachResponseDto,
  RecordEventDto,
  ReportIncidentDto,
  ResolveIncidentDto,
  TriageIncidentDto,
  UpdateIncidentDto,
} from './dto/incident.dto';
import { MS_PER_HOUR } from '@shared-kernel';

/** `detectedAt + 72h`, or null when this is not a personal-data breach. */
function notificationDueAt(incident: Incident): string | null {
  if (!incident.personalDataBreach) return null;
  return new Date(
    incident.detectedAt.getTime() + BREACH_NOTIFICATION_HOURS * MS_PER_HOUR,
  ).toISOString();
}

function toIncidentDto(i: Incident): IncidentResponseDto {
  return {
    id: i.id,
    reference: i.reference,
    title: i.title,
    description: i.description,
    category: i.category,
    severity: i.severity,
    status: i.status,
    detectedAt: i.detectedAt.toISOString(),
    reportedBy: i.reportedBy,
    assignedTo: i.assignedTo,
    containedAt: i.containedAt?.toISOString() ?? null,
    resolvedAt: i.resolvedAt?.toISOString() ?? null,
    closedAt: i.closedAt?.toISOString() ?? null,
    rootCause: i.rootCause,
    lessonsLearned: i.lessonsLearned,
    assetId: i.assetId,
    riskId: i.riskId,
    personalDataBreach: i.personalDataBreach,
    notificationDueAt: notificationDueAt(i),
    regulatorNotifiedAt: i.regulatorNotifiedAt?.toISOString() ?? null,
    createdAt: i.createdAt.toISOString(),
  };
}

function toEventDto(e: IncidentEvent): IncidentEventResponseDto {
  return {
    id: e.id,
    incidentId: e.incidentId,
    type: e.type,
    detail: e.detail,
    recordedBy: e.recordedBy,
    occurredAt: e.occurredAt.toISOString(),
    createdAt: e.createdAt.toISOString(),
  };
}

function toBreachDto(b: OverdueBreach): OverdueBreachResponseDto {
  return {
    id: b.id,
    reference: b.reference,
    title: b.title,
    severity: b.severity,
    detectedAt: new Date(b.detectedAt).toISOString(),
    notificationDueAt: new Date(b.notificationDueAt).toISOString(),
    hoursOverdue: b.hoursOverdue,
  };
}

@ApiTags('incidents')
@Controller('incidents')
@Auth()
export class IncidentController {
  constructor(
    private readonly service: IncidentService,
    private readonly employees: EmployeeService,
  ) {}

  /**
   * Raise an incident. NO permission required, deliberately.
   *
   * Anybody who notices something must be able to report it; an ISMS where raising an incident needs
   * a role is an ISMS where incidents go unreported. Handling is what `incident.manage` governs, and
   * the reporter is recorded from the token rather than supplied.
   */
  @Post('report')
  @AuthorizedInService(
    'any authenticated employee may report an incident — the reporter is taken from the token',
    'isms-incidents.e2e.spec.ts',
  )
  @ApiOperation({
    summary: 'Report an incident',
    description:
      '`detectedAt` is when it was DETECTED, not when this form was filled: every deadline counts ' +
      'from there, including the 72-hour breach-notification clock.',
  })
  @ApiCreatedResponse({ type: IncidentResponseDto })
  // 404 joins the list: an unknown `riskId`/`assetId` is refused by name now rather than surfacing as
  // a foreign-key violation the caller reads as a server fault.
  @ApiCommonErrors(401, 404, 409, 412, 422)
  async report(
    @Body() dto: ReportIncidentDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<IncidentResponseDto> {
    return toIncidentDto(await this.service.reportIncident(dto, user));
  }

  @Get()
  @RequirePermission('incident.read')
  @ApiOperation({
    summary: 'The incident register, worst and oldest first',
    description:
      'Ordered by severity descending then detection ascending — during a response the question is ' +
      'always the most serious thing that has been running longest. `openOnly` drops closed and ' +
      'dismissed.',
  })
  @ApiPagedResponse(IncidentResponseDto)
  @ApiCommonErrors(401, 403)
  async list(@Query() query: ListIncidentsQueryDto): Promise<PagedResult<IncidentResponseDto>> {
    const { rows, total } = await this.service.listIncidents(
      {
        status: query.status,
        severity: query.severity,
        category: query.category,
        assignedTo: query.assignedTo,
        riskId: query.riskId,
        openOnly: query.openOnly,
        breachesOnly: query.breachesOnly,
      },
      query.limit,
      query.offset,
    );
    return buildPageResult(rows.map(toIncidentDto), total, query.limit, query.offset);
  }

  @Get('breaches/overdue')
  @RequirePermission('incident.read')
  @ApiOperation({
    summary: 'Personal-data breaches past the 72-hour notification deadline',
    description:
      'GDPR Article 33 counts 72 hours from becoming aware. Most overdue first, with the shortfall ' +
      'computed in the query so nothing downstream recalculates it.',
  })
  @ApiOkResponse({ type: [OverdueBreachResponseDto] })
  @ApiCommonErrors(401, 403)
  async overdueBreaches(): Promise<OverdueBreachResponseDto[]> {
    return (await this.service.overdueBreaches()).map(toBreachDto);
  }

  @Get('unlinked-to-risk')
  @RequirePermission('incident.read')
  @ApiOperation({
    summary: 'Open incidents with no linked risk',
    description:
      "The register's feedback loop: an incident nobody foresaw is a gap in the risk assessment, " +
      'and this surfaces it rather than forcing a link at report time.',
  })
  @ApiOkResponse({ type: [IncidentResponseDto] })
  @ApiCommonErrors(401, 403)
  async unlinked(): Promise<IncidentResponseDto[]> {
    return (await this.service.unlinkedToRisk()).map(toIncidentDto);
  }

  @Get(':id')
  @RequirePermission('incident.read')
  @ApiOperation({ summary: 'Get an incident' })
  @ApiOkResponse({ type: IncidentResponseDto })
  @ApiCommonErrors(401, 403, 404)
  async getById(@Param('id', ParseUUIDPipe) id: string): Promise<IncidentResponseDto> {
    return toIncidentDto(await this.service.getIncident(id));
  }

  @Patch(':id')
  @RequirePermission('incident.manage')
  @ApiOperation({
    summary: 'Correct the details while handling continues',
    description:
      'Refused once the incident is closed or dismissed — add a timeline entry instead. Moving ' +
      '`detectedAt` past a recorded containment or resolution is refused too.',
  })
  @ApiOkResponse({ type: IncidentResponseDto })
  @ApiCommonErrors(401, 403, 404, 412, 422)
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateIncidentDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<IncidentResponseDto> {
    return toIncidentDto(await this.service.updateIncident(id, dto, user));
  }

  // ── Handling ─────────────────────────────────────────────────────────────────

  @Post(':id/triage')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('incident.manage')
  @ApiOperation({
    summary: 'Triage and assign a responder',
    description: 'Triage IS the assignment, so `assignedTo` is required.',
  })
  @ApiOkResponse({ type: IncidentResponseDto })
  @ApiCommonErrors(401, 403, 404, 409, 412, 422)
  async triage(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TriageIncidentDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<IncidentResponseDto> {
    // `assigned_to` carries no cross-schema FK, so without this a typo would assign it to nobody.
    await this.employees.assertExist(dto.assignedTo);
    return toIncidentDto(await this.service.triage(id, dto.assignedTo, user));
  }

  @Post(':id/contain')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('incident.manage')
  @ApiOperation({ summary: 'Record containment' })
  @ApiOkResponse({ type: IncidentResponseDto })
  @ApiCommonErrors(401, 403, 404, 409, 412, 422)
  async contain(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ContainIncidentDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<IncidentResponseDto> {
    return toIncidentDto(await this.service.contain(id, dto.containedAt, user));
  }

  @Post(':id/resolve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('incident.manage')
  @ApiOperation({
    summary: 'Resolve, with the root cause',
    description: 'The cause is required: an incident whose cause nobody knows is still open.',
  })
  @ApiOkResponse({ type: IncidentResponseDto })
  @ApiCommonErrors(401, 403, 404, 409, 412, 422)
  async resolve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveIncidentDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<IncidentResponseDto> {
    return toIncidentDto(await this.service.resolve(id, dto, user));
  }

  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('incident.manage')
  @ApiOperation({
    summary: 'Close, with what was learned',
    description:
      'ISO 27001 A.5.27 is "learning from information security incidents", so the lesson is ' +
      'required rather than encouraged.',
  })
  @ApiOkResponse({ type: IncidentResponseDto })
  @ApiCommonErrors(401, 403, 404, 409, 412, 422)
  async close(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CloseIncidentDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<IncidentResponseDto> {
    return toIncidentDto(await this.service.close(id, dto, user));
  }

  @Post(':id/dismiss')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('incident.manage')
  @ApiOperation({
    summary: 'Dismiss as a false positive',
    description:
      'Only from `reported` or `triaged`: once something has been contained it demonstrably was an ' +
      'incident, and dismissing it afterwards would contradict the containment timestamp.',
  })
  @ApiOkResponse({ type: IncidentResponseDto })
  @ApiCommonErrors(401, 403, 404, 409, 412, 422)
  async dismiss(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DismissIncidentDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<IncidentResponseDto> {
    return toIncidentDto(await this.service.dismiss(id, dto.reason, user));
  }

  // ── Timeline ─────────────────────────────────────────────────────────────────

  @Get(':id/timeline')
  @RequirePermission('incident.read')
  @ApiOperation({
    summary: 'The handling timeline, chronological',
    description:
      'Ordered by when things HAPPENED, not when they were written. Append-only: there is no edit ' +
      'and no delete, because a timeline somebody can revise afterwards is not evidence.',
  })
  @ApiOkResponse({ type: [IncidentEventResponseDto] })
  @ApiCommonErrors(401, 403, 404)
  async timeline(@Param('id', ParseUUIDPipe) id: string): Promise<IncidentEventResponseDto[]> {
    return (await this.service.listTimeline(id)).map(toEventDto);
  }

  @Post(':id/timeline')
  @RequirePermission('incident.manage')
  @ApiOperation({
    summary: 'Append a timeline entry',
    description:
      'Allowed after closure too: a post-incident review adds to the record, and refusing that ' +
      'would push the analysis somewhere the audit trail cannot see.',
  })
  @ApiCreatedResponse({ type: IncidentEventResponseDto })
  @ApiCommonErrors(401, 403, 404, 412, 422)
  async addEvent(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecordEventDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<IncidentEventResponseDto> {
    return toEventDto(await this.service.recordEvent(id, dto, user));
  }

  // ── Breach notification ──────────────────────────────────────────────────────

  @Post(':id/regulator-notified')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('incident.manage')
  @ApiOperation({
    summary: 'Record that the supervisory authority was notified',
    description:
      'Once only — the notification date is what the obligation turns on, so overwriting it would ' +
      'erase whether the 72 hours were met. Refused when the incident is not marked as a ' +
      'personal-data breach.',
  })
  @ApiOkResponse({ type: IncidentResponseDto })
  @ApiCommonErrors(401, 403, 404, 409, 412, 422)
  async notifyRegulator(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: NotifyRegulatorDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<IncidentResponseDto> {
    return toIncidentDto(await this.service.recordRegulatorNotification(id, dto.notifiedAt, user));
  }
}
