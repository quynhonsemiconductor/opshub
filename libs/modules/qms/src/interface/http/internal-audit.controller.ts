import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiCommonErrors,
  ApiPagedResponse,
  Auth,
  CurrentUser,
  RequirePermission,
  buildPageResult,
  type JwtPayload,
  type PagedResult,
} from '@platform';
import { EmployeeService } from '@modules/identity';
import { InternalAuditService } from '../../application/internal-audit.service';
import type { InternalAudit, InternalAuditRow } from '../../domain/internal-audit.types';
import {
  AssignAuditorDto,
  AuditAuditorResponseDto,
  AuditFindingResponseDto,
  CancelAuditDto,
  InternalAuditResponseDto,
  InternalAuditRowResponseDto,
  ListAuditsQueryDto,
  PlanAuditDto,
  ReportAuditDto,
  StartAuditDto,
  UnlinkedFindingResponseDto,
  UpdateAuditDto,
} from './dto/qms.dto';

/**
 * `leadAuditorName` is optional on the way in and always present on the way out: the read paths resolve
 * it, the lifecycle routes do not, because the SPA discards their responses and refetches.
 */
function toDto(a: InternalAudit & { leadAuditorName?: string | null }): InternalAuditResponseDto {
  return {
    id: a.id,
    reference: a.reference,
    title: a.title,
    objective: a.objective,
    scope: a.scope,
    criteria: a.criteria,
    status: a.status,
    leadAuditorId: a.leadAuditorId,
    leadAuditorName: a.leadAuditorName ?? null,
    plannedStartOn: a.plannedStartOn,
    plannedEndOn: a.plannedEndOn,
    startedAt: a.startedAt?.toISOString() ?? null,
    reportedAt: a.reportedAt?.toISOString() ?? null,
    conclusion: a.conclusion,
    reportDocumentId: a.reportDocumentId,
    closedAt: a.closedAt?.toISOString() ?? null,
    cancelReason: a.cancelReason,
    createdAt: a.createdAt.toISOString(),
  };
}

function toRowDto(
  r: InternalAuditRow & { leadAuditorName?: string | null },
): InternalAuditRowResponseDto {
  return {
    ...toDto(r),
    auditorCount: r.auditorCount,
    findingCount: r.findingCount,
    openFindingCount: r.openFindingCount,
  };
}

@ApiTags('internal-audits')
@Controller('internal-audits')
@Auth()
export class InternalAuditController {
  constructor(
    private readonly service: InternalAuditService,
    private readonly employees: EmployeeService,
  ) {}

  // ── Static paths first, before `:id` ─────────────────────────────────────────

  @Get('reports/unlinked-findings')
  @RequirePermission('internal_audit.read')
  @ApiOperation({
    summary: 'Findings that claim an internal-audit source but name no audit',
    description:
      'The traceability gap `nonconformances.internal_audit_id` leaves open deliberately: a finding ' +
      'written up during fieldwork before the engagement row exists is ordinary, so the link is not ' +
      'forced. One still unlinked weeks later is a hole in the programme — and it also means the ' +
      'impartiality rule cannot see it, because there is no roster to check against. Oldest first.',
  })
  @ApiOkResponse({ type: [UnlinkedFindingResponseDto] })
  @ApiCommonErrors(401, 403)
  async unlinkedFindings(): Promise<UnlinkedFindingResponseDto[]> {
    return (await this.service.unlinkedFindings()).map((f) => ({
      ...f,
      detectedAt: f.detectedAt.toISOString(),
    }));
  }

  @Get()
  @RequirePermission('internal_audit.read')
  @ApiOperation({
    summary: 'The audit programme',
    description:
      'Soonest planned start first, undated last. Each row carries its roster size (auditors only — ' +
      'observers are excluded) and its finding counts, resolved in the same query.',
  })
  @ApiPagedResponse(InternalAuditRowResponseDto)
  @ApiCommonErrors(401, 403)
  async list(
    @Query() query: ListAuditsQueryDto,
  ): Promise<PagedResult<InternalAuditRowResponseDto>> {
    const { rows, total } = await this.service.list(
      {
        status: query.status,
        leadAuditorId: query.leadAuditorId,
        auditorId: query.auditorId,
        openOnly: query.openOnly,
        plannedStartOnOrBefore: query.plannedStartOnOrBefore,
        search: query.search,
      },
      query.limit,
      query.offset,
    );
    return buildPageResult(rows.map(toRowDto), total, query.limit, query.offset);
  }

  @Post()
  @RequirePermission('internal_audit.manage')
  @ApiOperation({
    summary: 'Plan an audit',
    description:
      'Scope and criteria are both required and both substantial — §9.2.2(b). They answer different ' +
      'questions: scope is where you looked, criteria is what you judged against, and an audit ' +
      'missing either cannot be repeated or defended. The lead auditor joins the roster as `lead` in ' +
      'the same transaction.',
  })
  @ApiCreatedResponse({ type: InternalAuditResponseDto })
  @ApiCommonErrors(400, 401, 403, 404, 409, 412)
  async plan(
    @Body() dto: PlanAuditDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<InternalAuditResponseDto> {
    // `lead_auditor_id` carries no cross-schema FK, so without this a typo would name nobody.
    await this.employees.assertExist(dto.leadAuditorId);
    return toDto(await this.service.plan(dto, user));
  }

  @Get(':id')
  @RequirePermission('internal_audit.read')
  @ApiOperation({ summary: 'One audit' })
  @ApiOkResponse({ type: InternalAuditResponseDto })
  @ApiCommonErrors(401, 403, 404)
  async getOne(@Param('id', ParseUUIDPipe) id: string): Promise<InternalAuditResponseDto> {
    // `getWithLeadAuditor`, not `getById` — see its docblock for why the guard the lifecycle routes
    // share was not widened to do this.
    return toDto(await this.service.getWithLeadAuditor(id));
  }

  @Patch(':id')
  @RequirePermission('internal_audit.manage')
  @ApiOperation({
    summary: 'Correct a planned or running audit',
    description:
      'The status is NOT settable here — reporting through a patch would skip the conclusion and the ' +
      'report document. Changing the lead moves the roster with it: the new lead becomes `lead` and ' +
      'the previous one stays on as `auditor`, because they may well have done fieldwork and dropping ' +
      'them would erase that from the impartiality rule.',
  })
  @ApiOkResponse({ type: InternalAuditResponseDto })
  @ApiCommonErrors(400, 401, 403, 404, 412)
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAuditDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<InternalAuditResponseDto> {
    await this.employees.assertExist(dto.leadAuditorId);
    return toDto(await this.service.update(id, dto, user));
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  @Post(':id/start')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('internal_audit.manage')
  @ApiOperation({
    summary: 'Begin fieldwork',
    description:
      'Refused when nobody is rostered as lead or auditor — an audit needs somebody to do it.',
  })
  @ApiOkResponse({ type: InternalAuditResponseDto })
  @ApiCommonErrors(400, 401, 403, 404, 409, 412)
  async start(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: StartAuditDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<InternalAuditResponseDto> {
    return toDto(await this.service.start(id, dto.startedAt, user));
  }

  @Post(':id/report')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('internal_audit.manage')
  @ApiOperation({
    summary: 'Report the results to management (§9.2.2(d))',
    description:
      'Its own state, not a timestamp on closure: an audit whose fieldwork finished and whose results ' +
      'never reached anybody has not been done. Both the conclusion and the report document are ' +
      'required, and `closed` is only reachable from here — there is no way to close an unreported ' +
      'audit. Deliberately NOT gated behind a scarcer permission: the audit team reports what it ' +
      'found, and what is separated instead is the effectiveness review of any action arising.',
  })
  @ApiOkResponse({ type: InternalAuditResponseDto })
  @ApiCommonErrors(400, 401, 403, 404, 409, 412)
  async report(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReportAuditDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<InternalAuditResponseDto> {
    return toDto(await this.service.report(id, dto.conclusion, dto.reportDocumentId, user));
  }

  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('internal_audit.manage')
  @ApiOperation({
    summary: 'Close the engagement',
    description:
      'Does NOT require the findings to be closed. §9.2.2(e) asks for action without undue delay and ' +
      'the CAPA machinery tracks that per finding with its own gate; an audit held open until every ' +
      'corrective action is verified would stay open for months and stop meaning anything. The ' +
      'open-finding count on the programme row is how a reader sees what is outstanding.',
  })
  @ApiOkResponse({ type: InternalAuditResponseDto })
  @ApiCommonErrors(401, 403, 404, 409, 412)
  async close(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<InternalAuditResponseDto> {
    return toDto(await this.service.close(id, user));
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('internal_audit.manage')
  @ApiOperation({
    summary: 'Record an audit that did not happen',
    description:
      'Reachable from `planned` and `in_progress` but NOT from `reported`: once results have been ' +
      'reported the audit happened, and the record of it is not cancellable.',
  })
  @ApiOkResponse({ type: InternalAuditResponseDto })
  @ApiCommonErrors(400, 401, 403, 404, 409, 412)
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelAuditDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<InternalAuditResponseDto> {
    return toDto(await this.service.cancel(id, dto.reason, user));
  }

  // ── The roster ───────────────────────────────────────────────────────────────

  @Get(':id/auditors')
  @RequirePermission('internal_audit.read')
  @ApiOperation({ summary: 'Who audited, and in what capacity — lead first' })
  @ApiOkResponse({ type: [AuditAuditorResponseDto] })
  @ApiCommonErrors(401, 403, 404)
  async auditors(@Param('id', ParseUUIDPipe) id: string): Promise<AuditAuditorResponseDto[]> {
    return (await this.service.listAuditors(id)).map((a) => ({
      auditorId: a.auditorId,
      auditorName: a.auditorName,
      role: a.role,
      addedBy: a.addedBy,
      createdAt: a.createdAt.toISOString(),
    }));
  }

  @Put(':id/auditors/:auditorId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('internal_audit.manage')
  @ApiOperation({
    summary: 'Put somebody on the audit, or change their role',
    description:
      'Idempotent on the pair, so re-adding CHANGES the role — swapping an observer onto the audit ' +
      'team is one action to the person doing it. Assigning `lead` makes them the lead and moves the ' +
      'previous lead to `auditor`. An `observer` does not count as having audited, which is what the ' +
      'impartiality rule on `POST /capas/:id/verify` reads.',
  })
  @ApiCommonErrors(400, 401, 403, 404, 412)
  async assignAuditor(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('auditorId', ParseUUIDPipe) auditorId: string,
    @Body() dto: AssignAuditorDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<void> {
    await this.employees.assertExist(auditorId);
    await this.service.assignAuditor(id, auditorId, dto.role, user);
  }

  @Delete(':id/auditors/:auditorId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('internal_audit.manage')
  @ApiOperation({
    summary: 'Take somebody off the audit',
    description:
      'The LEAD cannot be removed, only replaced: `lead_auditor_id` is NOT NULL, so removing that ' +
      'roster row would leave the column naming somebody who is not on the audit.',
  })
  @ApiCommonErrors(401, 403, 404, 412)
  async removeAuditor(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('auditorId', ParseUUIDPipe) auditorId: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<void> {
    await this.service.removeAuditor(id, auditorId, user);
  }

  // ── Findings ─────────────────────────────────────────────────────────────────

  @Get(':id/findings')
  @RequirePermission('internal_audit.read')
  @ApiOperation({
    summary: 'Findings raised against this audit, worst grade first',
    description:
      'These are non-conformances — an audit finding IS one, so it carries the same grade, the same ' +
      'containment and the same closure gate rather than a parallel copy. Raise them through ' +
      '`POST /nonconformances/report` with `internalAuditId` set.',
  })
  @ApiOkResponse({ type: [AuditFindingResponseDto] })
  @ApiCommonErrors(401, 403, 404)
  async findings(@Param('id', ParseUUIDPipe) id: string): Promise<AuditFindingResponseDto[]> {
    return (await this.service.listFindings(id)).map((f) => ({
      ...f,
      detectedAt: f.detectedAt.toISOString(),
    }));
  }
}
