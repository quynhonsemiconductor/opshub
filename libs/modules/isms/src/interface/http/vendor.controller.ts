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
import { DocumentsService } from '@modules/documents';
import { toRiskDto } from './risk.controller';
import { RiskResponseDto } from './dto/risk.dto';
import { VendorService } from '../../application/vendor.service';
import type { Vendor, VendorAssessment, VendorRow } from '../../domain/vendor.types';
import {
  ListVendorsQueryDto,
  RecordAssessmentDto,
  RegisterVendorDto,
  UnassessedSpendResponseDto,
  UpdateVendorDto,
  VendorAssessmentResponseDto,
  VendorCriticalityLevelResponseDto,
  VendorReasonDto,
  VendorResponseDto,
  VendorReviewGapResponseDto,
  VendorRowResponseDto,
} from './dto/vendor.dto';

function toDto(v: Vendor & { ownerName?: string | null }): VendorResponseDto {
  return {
    id: v.id,
    reference: v.reference,
    name: v.name,
    legalName: v.legalName,
    services: v.services,
    criticality: v.criticality,
    status: v.status,
    ownerId: v.ownerId,
    // Absent on the write paths and on the critical-without-risk report, none of which render an
    // owner — see `VendorResponseDto.ownerName`. Never `?? v.ownerId`: that puts the uuid back.
    ownerName: v.ownerName ?? null,
    dataProcessor: v.dataProcessor,
    dataProcessingAgreementId: v.dataProcessingAgreementId,
    dataLocation: v.dataLocation,
    contractStartsOn: v.contractStartsOn,
    contractEndsOn: v.contractEndsOn,
    noticePeriodDays: v.noticePeriodDays,
    reviewDueOn: v.reviewDueOn,
    terminatedAt: v.terminatedAt?.toISOString() ?? null,
    terminationReason: v.terminationReason,
    createdAt: v.createdAt.toISOString(),
  };
}

function toRowDto(r: VendorRow & { ownerName?: string | null }): VendorRowResponseDto {
  return {
    ...toDto(r),
    criticalityRank: r.criticalityRank,
    reviewIntervalMonths: r.reviewIntervalMonths,
    requiresIndependentEvidence: r.requiresIndependentEvidence,
    lastAssessedAt: r.lastAssessedAt ? new Date(r.lastAssessedAt).toISOString() : null,
    lastOutcome: r.lastOutcome,
    riskCount: r.riskCount,
  };
}

function toAssessmentDto(a: VendorAssessment): VendorAssessmentResponseDto {
  return {
    id: a.id,
    vendorId: a.vendorId,
    assessedAt: a.assessedAt.toISOString(),
    assessedBy: a.assessedBy,
    outcome: a.outcome,
    scope: a.scope,
    findings: a.findings,
    conditions: a.conditions,
    evidenceDocumentId: a.evidenceDocumentId,
  };
}

@ApiTags('vendors')
@Controller('vendors')
@Auth()
export class VendorController {
  constructor(
    private readonly service: VendorService,
    private readonly employees: EmployeeService,
    private readonly documents: DocumentsService,
  ) {}

  // ── Static paths first ───────────────────────────────────────────────────────
  //
  // Declared before `:id`, because Nest matches in declaration order and
  // `criticality-levels` would otherwise be handed to the by-id route, where
  // `ParseUUIDPipe` turns it into a puzzling 400.

  @Get('criticality-levels')
  @RequirePermission('vendor.read')
  @ApiOperation({
    summary: 'The criticality tiers, their ranking and the reassessment cadence each demands',
    description:
      'The RANK here is authoritative — nothing should infer the ordering from the order the tiers ' +
      'appear in. `reviewIntervalMonths` is what `reviewDueOn` is computed from.',
  })
  @ApiOkResponse({ type: [VendorCriticalityLevelResponseDto] })
  @ApiCommonErrors(401, 403)
  async levels(): Promise<VendorCriticalityLevelResponseDto[]> {
    return (await this.service.listLevels()).map((l) => ({
      code: l.code,
      rank: l.rank,
      label: l.label,
      description: l.description,
      reviewIntervalMonths: l.reviewIntervalMonths,
      requiresIndependentEvidence: l.requiresIndependentEvidence,
    }));
  }

  @Get('reports/review-gaps')
  @RequirePermission('vendor.read')
  @ApiOperation({
    summary: 'Suppliers never assessed, or past the cadence their tier demands',
    description:
      'Never-assessed first, because "nobody has ever looked" is worse than "the last look is ' +
      'stale". `daysOverdue` is null for those, since there is no interval to be overdue by. ' +
      'Covers `active` and `suspended` suppliers only: a prospective one is not yet relied upon ' +
      'and a terminated one needs no reassessment.',
  })
  @ApiOkResponse({ type: [VendorReviewGapResponseDto] })
  @ApiCommonErrors(401, 403)
  async reviewGaps(): Promise<VendorReviewGapResponseDto[]> {
    return (await this.service.reviewGaps()).map((g) => ({
      ...g,
      lastAssessedAt: g.lastAssessedAt ? new Date(g.lastAssessedAt).toISOString() : null,
    }));
  }

  @Get('reports/critical-without-risk')
  @RequirePermission('vendor.read')
  @ApiOperation({
    summary: 'Active top-tier suppliers with no register risk linked',
    description:
      'The same anti-join as the untreated-risk and unlinked-incident reports: depending on a ' +
      'critical supplier while recording no risk about them is a gap in the assessment, not an ' +
      'absence of risk. The tiers included are chosen by RANK, so adding a tier above `critical` ' +
      'widens this report without anybody editing it.',
  })
  @ApiOkResponse({ type: [VendorResponseDto] })
  @ApiCommonErrors(401, 403)
  async criticalWithoutRisk(): Promise<VendorResponseDto[]> {
    return (await this.service.criticalWithoutRisk()).map(toDto);
  }

  @Get('reports/unassessed-spend')
  @RequirePermission('vendor.read')
  @ApiOperation({
    summary: 'Active licences whose supplier is unlinked or unassessed',
    description:
      'Money going somewhere nobody checked. Two shapes of gap are reported together because they ' +
      'are one problem to whoever acts on them: a licence not linked to the register, and a ' +
      'licence whose supplier has never been assessed. Soonest renewal first — that is the ' +
      'deadline by which the gap has to close or the payment stops.',
  })
  @ApiOkResponse({ type: [UnassessedSpendResponseDto] })
  @ApiCommonErrors(401, 403)
  async unassessedSpend(): Promise<UnassessedSpendResponseDto[]> {
    return this.service.unassessedSpend();
  }

  // ── The register ─────────────────────────────────────────────────────────────

  @Get()
  @RequirePermission('vendor.read')
  @ApiOperation({
    summary: 'The supplier register',
    description:
      'Most critical first. Terminated suppliers are excluded unless `includeTerminated` is set, ' +
      'because the register means who we use now. Each row carries its tier rank and cadence and ' +
      'its latest assessment, resolved in the same query.',
  })
  @ApiPagedResponse(VendorRowResponseDto)
  @ApiCommonErrors(401, 403)
  async list(@Query() query: ListVendorsQueryDto): Promise<PagedResult<VendorRowResponseDto>> {
    const { rows, total } = await this.service.list(
      {
        status: query.status,
        criticality: query.criticality,
        ownerId: query.ownerId,
        processorsOnly: query.processorsOnly,
        reviewDueOnOrBefore: query.reviewDueOnOrBefore,
        includeTerminated: query.includeTerminated,
        search: query.search,
      },
      query.limit,
      query.offset,
    );
    return buildPageResult(rows.map(toRowDto), total, query.limit, query.offset);
  }

  @Post()
  @RequirePermission('vendor.manage')
  @ApiOperation({
    summary: 'Register a supplier',
    description:
      'Registered as `prospective`: assessed but not yet relied upon. Going live is a separate ' +
      'act with its own permission and its own preconditions — see `POST /vendors/:id/activate`. ' +
      '`dataProcessingAgreementId` must name a controlled document if given (404 otherwise).',
  })
  @ApiCreatedResponse({ type: VendorResponseDto })
  @ApiCommonErrors(400, 401, 403, 404, 409, 412)
  async register(
    @Body() dto: RegisterVendorDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<VendorResponseDto> {
    // `owner_id` carries no cross-schema FK, so without this a typo would name nobody.
    await this.employees.assertExist(dto.ownerId);
    return toDto(await this.service.register(dto, user));
  }

  @Get(':id')
  @RequirePermission('vendor.read')
  @ApiOperation({ summary: 'One supplier' })
  @ApiOkResponse({ type: VendorResponseDto })
  @ApiCommonErrors(401, 403, 404)
  async getOne(@Param('id', ParseUUIDPipe) id: string): Promise<VendorResponseDto> {
    // The read path, so it resolves the owner's name. `getById` is the write-path guard and stays
    // free of the lookup.
    return toDto(await this.service.getByIdWithOwner(id));
  }

  @Patch(':id')
  @RequirePermission('vendor.manage')
  @ApiOperation({
    summary: 'Correct a supplier record',
    description:
      'The status is NOT settable here — approving through a patch would skip the assessment ' +
      'requirement. `reviewDueOn` is not settable either: it is computed when an assessment is ' +
      'recorded, and a cadence the caller can move is not a cadence. Correcting `criticality` DOES ' +
      'move it, because the tier is the cadence — it is recomputed from the last assessment and the ' +
      'new interval, so the review-gap report reflects the correction immediately. An unknown ' +
      '`dataProcessingAgreementId` is a 404 naming the field.',
  })
  @ApiOkResponse({ type: VendorResponseDto })
  @ApiCommonErrors(400, 401, 403, 404, 412)
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateVendorDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<VendorResponseDto> {
    await this.employees.assertExist(dto.ownerId);
    return toDto(await this.service.update(id, dto, user));
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('vendor.approve')
  @ApiOperation({
    summary: 'Approve a supplier for live use',
    description:
      'Requires a CURRENT PASSING ASSESSMENT — a rule about the latest row of another table, which ' +
      'no CHECK can express. A data processor also needs a recorded agreement (GDPR Article ' +
      '28(3)). `vendor.approve` is in no default role bundle, like `risk.accept` and ' +
      '`information_asset.declassify`: the person who ran the due diligence should not be the only ' +
      'one who decides we may now depend on it.',
  })
  @ApiOkResponse({ type: VendorResponseDto })
  @ApiCommonErrors(401, 403, 404, 409, 412)
  async activate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<VendorResponseDto> {
    return toDto(await this.service.activate(id, user));
  }

  @Post(':id/suspend')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('vendor.manage')
  @ApiOperation({
    summary: 'Stop relying on a supplier without ending the relationship',
    description:
      'Only `vendor.manage`, not `vendor.approve`. Stopping is never the risky direction, and ' +
      'requiring the scarcer permission to suspend would be a reason not to.',
  })
  @ApiOkResponse({ type: VendorResponseDto })
  @ApiCommonErrors(400, 401, 403, 404, 409, 412)
  async suspend(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VendorReasonDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<VendorResponseDto> {
    return toDto(await this.service.suspend(id, dto.reason, user));
  }

  @Post(':id/reinstate')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('vendor.approve')
  @ApiOperation({
    summary: 'Return a suspended supplier to live use',
    description:
      'Held to the same preconditions as activation rather than being a plain status flip: ' +
      'whatever caused the suspension is exactly the reason to re-check the assessment.',
  })
  @ApiOkResponse({ type: VendorResponseDto })
  @ApiCommonErrors(401, 403, 404, 409, 412)
  async reinstate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<VendorResponseDto> {
    return toDto(await this.service.reinstate(id, user));
  }

  @Post(':id/terminate')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('vendor.manage')
  @ApiOperation({
    summary: 'End the relationship',
    description:
      'Terminal. Restarting with a supplier means assessing them again, which means a new register ' +
      'entry — resurrecting the old row would carry its stale assessment forward. The record, its ' +
      'assessments and its risk links all stay: they are the audit evidence.',
  })
  @ApiOkResponse({ type: VendorResponseDto })
  @ApiCommonErrors(400, 401, 403, 404, 409, 412)
  async terminate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VendorReasonDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<VendorResponseDto> {
    return toDto(await this.service.terminate(id, dto.reason, user));
  }

  // ── Assessments ──────────────────────────────────────────────────────────────

  @Post(':id/assessments')
  @RequirePermission('vendor.manage')
  @ApiOperation({
    summary: 'Record a due-diligence assessment',
    description:
      'Moves the next review date with it, computed from the tier — an assessment that does not ' +
      'reset the clock leaves the supplier permanently overdue. A conditional pass must state its ' +
      'conditions and a failure must state its findings.',
  })
  @ApiCreatedResponse({ type: VendorAssessmentResponseDto })
  @ApiCommonErrors(400, 401, 403, 404, 412)
  async assess(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecordAssessmentDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<VendorAssessmentResponseDto> {
    // The assessment's evidence is the substance of the assessment. Its schema comment claimed the
    // service checked it and nothing did — the last of the five cross-schema document references
    // that said so.
    await this.documents.assertExist(dto.evidenceDocumentId);
    return toAssessmentDto(await this.service.assess(id, dto, user));
  }

  @Get(':id/assessments')
  @RequirePermission('vendor.read')
  @ApiOperation({
    summary: 'Every assessment of this supplier',
    description:
      'Latest first. Append-only: the application holds no privilege to update or delete these ' +
      "rows, because last year's result is the evidence that last year's decision was reasonable.",
  })
  @ApiOkResponse({ type: [VendorAssessmentResponseDto] })
  @ApiCommonErrors(401, 403, 404)
  async assessments(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<VendorAssessmentResponseDto[]> {
    return (await this.service.listAssessments(id)).map(toAssessmentDto);
  }

  // ── Vendor ↔ risk ────────────────────────────────────────────────────────────

  @Get(':id/risks')
  @RequirePermission('vendor.read')
  @ApiOperation({ summary: 'Register risks linked to this supplier, worst first' })
  @ApiOkResponse({ type: [RiskResponseDto] })
  @ApiCommonErrors(401, 403, 404)
  async risks(@Param('id', ParseUUIDPipe) id: string): Promise<RiskResponseDto[]> {
    // The risk register's own mapper, imported rather than reimplemented.
    //
    // `ownerName` therefore comes back null here, deliberately: the supplier drawer's risk panel
    // shows the reference, the scores and the status, and resolving a name no screen prints would be
    // a query per supplier for nothing. The register's own list and single read do resolve it.
    return (await this.service.listRisks(id)).map(toRiskDto);
  }

  @Put(':id/risks/:riskId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('vendor.manage')
  @ApiOperation({
    summary: 'Record that this supplier carries a register risk',
    description: 'Idempotent — the pair is the natural key, so linking twice is still one link.',
  })
  @ApiCommonErrors(401, 403, 404, 412)
  async linkRisk(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('riskId', ParseUUIDPipe) riskId: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<void> {
    await this.service.linkRisk(id, riskId, user);
  }

  @Delete(':id/risks/:riskId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('vendor.manage')
  @ApiOperation({ summary: 'Remove the link between this supplier and a risk' })
  @ApiCommonErrors(401, 403, 404)
  async unlinkRisk(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('riskId', ParseUUIDPipe) riskId: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<void> {
    await this.service.unlinkRisk(id, riskId, user);
  }
}
