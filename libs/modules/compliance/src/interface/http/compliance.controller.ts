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
import {
  ApiAcceptedResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  Auth,
  RequirePermission,
  ApiCommonErrors,
  ApiPagedResponse,
  buildPageResult,
  CurrentUser,
} from '@platform';
import type { JwtPayload, PagedResult } from '@platform';
import { AuditService, AUDIT_ACTION, AUDIT_RESOURCE } from '@modules/audit';
import { ComplianceService } from '../../application/compliance.service';
import { GRAPH_TASK, GraphTaskQueue } from '@modules/graph';
import { ShadowItFindingsService } from '../../application/shadow-it-findings.service';
import {
  AddSoftwareDto,
  UpdateSoftwareDto,
  ListSoftwareQueryDto,
  ListFindingsQueryDto,
  ResolveFindingDto,
  SoftwareResponseDto,
  FindingResponseDto,
  ShadowItListResponseDto,
  ShadowItScanQueuedDto,
} from './dto/compliance.dto';
import type { ComplianceFinding, SoftwareCatalogEntry } from '../../domain/compliance.types';

function toSoftwareDto(s: SoftwareCatalogEntry): SoftwareResponseDto {
  return {
    id: s.id,
    name: s.name,
    publisher: s.publisher,
    listing: s.listing,
    notes: s.notes,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

function toFindingDto(f: ComplianceFinding): FindingResponseDto {
  return {
    id: f.id,
    assetId: f.assetId,
    employeeId: f.employeeId,
    softwareName: f.softwareName,
    softwareVersion: f.softwareVersion,
    severity: f.severity,
    status: f.status,
    source: f.source,
    detectedAt: f.detectedAt.toISOString(),
    resolvedBy: f.resolvedBy,
    resolutionNote: f.resolutionNote,
    resolvedAt: f.resolvedAt ? f.resolvedAt.toISOString() : null,
  };
}

@ApiTags('compliance')
@Controller('compliance')
@Auth()
export class ComplianceController {
  constructor(
    private readonly service: ComplianceService,
    private readonly audit: AuditService,
    private readonly shadowIt: ShadowItFindingsService,
    private readonly graphTasks: GraphTaskQueue,
  ) {}

  // ── Software catalog ───────────────────────────────────────────────────────

  @Get('software')
  @RequirePermission('compliance.read')
  @ApiOperation({ summary: 'List the software catalog (whitelist/blacklist)' })
  @ApiPagedResponse(SoftwareResponseDto)
  @ApiCommonErrors(401)
  async listSoftware(
    @Query() query: ListSoftwareQueryDto,
  ): Promise<PagedResult<SoftwareResponseDto>> {
    const { rows, total } = await this.service.listSoftware(
      { listing: query.listing, search: query.search },
      query.limit,
      query.offset,
    );
    return buildPageResult(rows.map(toSoftwareDto), total, query.limit, query.offset);
  }

  @Get('software/:id')
  @RequirePermission('compliance.read')
  @ApiOperation({ summary: 'Get a software catalog entry' })
  @ApiOkResponse({ type: SoftwareResponseDto })
  @ApiCommonErrors(401, 404)
  async getSoftware(@Param('id', ParseUUIDPipe) id: string): Promise<SoftwareResponseDto> {
    return toSoftwareDto(await this.service.getSoftware(id));
  }

  @Post('software')
  @RequirePermission('compliance.manage')
  @ApiOperation({ summary: 'Add a software catalog entry' })
  @ApiCreatedResponse({ type: SoftwareResponseDto })
  @ApiCommonErrors(401, 403, 409, 422)
  async addSoftware(
    @Body() dto: AddSoftwareDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<SoftwareResponseDto> {
    const entry = await this.service.addSoftware(dto, user);
    return toSoftwareDto(entry);
  }

  @Patch('software/:id')
  @RequirePermission('compliance.manage')
  @ApiOperation({ summary: 'Update a software catalog entry' })
  @ApiOkResponse({ type: SoftwareResponseDto })
  @ApiCommonErrors(401, 403, 404, 422)
  async updateSoftware(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSoftwareDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<SoftwareResponseDto> {
    const entry = await this.service.updateSoftware(id, dto, user);
    return toSoftwareDto(entry);
  }

  // ── Findings ───────────────────────────────────────────────────────────────

  @Get('findings')
  @RequirePermission('compliance.read')
  @ApiOperation({ summary: 'List compliance findings' })
  @ApiPagedResponse(FindingResponseDto)
  @ApiCommonErrors(401, 403)
  async listFindings(
    @Query() query: ListFindingsQueryDto,
  ): Promise<PagedResult<FindingResponseDto>> {
    const { rows, total } = await this.service.listFindings(
      {
        status: query.status,
        severity: query.severity,
        assetId: query.assetId,
        employeeId: query.employeeId,
      },
      query.limit,
      query.offset,
    );
    return buildPageResult(rows.map(toFindingDto), total, query.limit, query.offset);
  }

  @Get('findings/:id')
  @RequirePermission('compliance.read')
  @ApiOperation({ summary: 'Get a compliance finding' })
  @ApiOkResponse({ type: FindingResponseDto })
  @ApiCommonErrors(401, 403, 404)
  async getFinding(@Param('id', ParseUUIDPipe) id: string): Promise<FindingResponseDto> {
    return toFindingDto(await this.service.getFinding(id));
  }

  @Post('findings/:id/acknowledge')
  // 200, not Nest's default 201: this is a state transition, not a creation, and `@ApiOkResponse`
  // already promises 200 — without this the generated client's contract disagreed with the server.
  @HttpCode(HttpStatus.OK)
  @RequirePermission('compliance.manage')
  @ApiOperation({ summary: 'Acknowledge an open finding' })
  @ApiOkResponse({ type: FindingResponseDto })
  @ApiCommonErrors(401, 403, 404, 412)
  async acknowledge(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<FindingResponseDto> {
    const finding = await this.service.acknowledgeFinding(id, user);
    return toFindingDto(finding);
  }

  @Post('findings/:id/resolve')
  // 200, not Nest's default 201: this is a state transition, not a creation, and `@ApiOkResponse`
  // already promises 200 — without this the generated client's contract disagreed with the server.
  @HttpCode(HttpStatus.OK)
  @RequirePermission('compliance.manage')
  @ApiOperation({ summary: 'Resolve (or risk-accept) a finding' })
  @ApiOkResponse({ type: FindingResponseDto })
  @ApiCommonErrors(401, 403, 404, 412)
  async resolve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveFindingDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<FindingResponseDto> {
    const finding = await this.service.resolveFinding(id, dto.note ?? null, dto.riskAccepted, user);
    void this.audit.record({
      actorId: user.sub,
      actorEmail: user.email,
      action: AUDIT_ACTION.FINDING_RESOLVED,
      resourceType: AUDIT_RESOURCE.COMPLIANCE_FINDING,
      resourceId: id,
      metadata: { riskAccepted: dto.riskAccepted, note: dto.note ?? null },
    });
    return toFindingDto(finding);
  }

  // ── Shadow IT ──────────────────────────────────────────────────────────────

  @Get('shadow-it')
  @RequirePermission('compliance.read')
  @ApiOperation({
    summary: 'List Shadow IT findings (non-whitelisted apps detected on managed devices)',
  })
  @ApiOkResponse({ type: ShadowItListResponseDto })
  @ApiCommonErrors(401, 403)
  async listShadowIt(): Promise<ShadowItListResponseDto> {
    const findings = await this.shadowIt.listShadowItFindings(100);
    return { findings: findings.map(toFindingDto), total: findings.length };
  }

  @Post('shadow-it/scan')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission('compliance.manage')
  @ApiOperation({
    summary: 'Queue a Shadow IT detection scan (the worker runs it; 202 Accepted)',
  })
  @ApiAcceptedResponse({ type: ShadowItScanQueuedDto })
  @ApiCommonErrors(401, 403)
  async triggerShadowItScan(@CurrentUser() user: JwtPayload): Promise<ShadowItScanQueuedDto> {
    // Enqueued, not run: the API holds no Graph credential, and a scan walks the whole Intune inventory.
    // A scan already waiting covers this request (`queued: false`).
    const queued = await this.graphTasks.enqueue({ kind: GRAPH_TASK.SHADOW_IT_SCAN, payload: {} });
    void this.audit.record({
      actorId: user.sub,
      actorEmail: user.email,
      action: AUDIT_ACTION.SHADOW_IT_SCAN_TRIGGERED,
      resourceType: AUDIT_RESOURCE.COMPLIANCE,
      resourceId: 'shadow-it',
      metadata: { queued },
    });
    return { queued };
  }
}
