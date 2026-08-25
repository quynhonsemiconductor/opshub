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
  CurrentUser,
  RequirePermission,
  buildPageResult,
  type JwtPayload,
  type PagedResult,
} from '@platform';
import { EmployeeService } from '@modules/identity';
import { RiskService } from '../../application/risk.service';
import type { Risk, RiskTreatment } from '../../domain/risk.types';
import {
  AcceptRiskDto,
  AcceptRiskResponseDto,
  AddTreatmentDto,
  AssessRiskDto,
  CloseRiskDto,
  IdentifyRiskDto,
  ListRisksQueryDto,
  MarkTreatedDto,
  RiskResponseDto,
  RiskTreatmentResponseDto,
  UpdateRiskDto,
  UpdateTreatmentDto,
} from './dto/risk.dto';

/**
 * Exported so the vendor controller can render the risks linked to a supplier with the SAME shape.
 *
 * A second mapper is how one of them silently stops emitting a field that a screen reads.
 */
export function toRiskDto(
  r: Risk & { ownerName?: string | null; acceptedByName?: string | null },
): RiskResponseDto {
  return {
    id: r.id,
    reference: r.reference,
    title: r.title,
    description: r.description,
    category: r.category,
    assetId: r.assetId,
    ownerId: r.ownerId,
    // Absent on the write paths and on the supplier's linked-risk list, none of which render an
    // owner — see `RiskResponseDto.ownerName`. Never `?? r.ownerId`: that puts the uuid back.
    ownerName: r.ownerName ?? null,
    inherentLikelihood: r.inherentLikelihood,
    inherentImpact: r.inherentImpact,
    inherentScore: r.inherentScore,
    treatmentDecision: r.treatmentDecision,
    residualLikelihood: r.residualLikelihood,
    residualImpact: r.residualImpact,
    residualScore: r.residualScore,
    status: r.status,
    reviewDueOn: r.reviewDueOn,
    acceptedBy: r.acceptedBy,
    acceptedByName: r.acceptedByName ?? null,
    acceptedAt: r.acceptedAt?.toISOString() ?? null,
    acceptanceJustification: r.acceptanceJustification,
    acceptedViaRequestId: r.acceptedViaRequestId,
    closedAt: r.closedAt?.toISOString() ?? null,
    closureNote: r.closureNote,
    createdAt: r.createdAt.toISOString(),
  };
}

function toTreatmentDto(t: RiskTreatment): RiskTreatmentResponseDto {
  return {
    id: t.id,
    riskId: t.riskId,
    description: t.description,
    ownerId: t.ownerId,
    dueOn: t.dueOn,
    status: t.status,
    completedOn: t.completedOn,
    createdAt: t.createdAt.toISOString(),
  };
}

@ApiTags('risks')
@Controller('risks')
@Auth()
export class RiskController {
  constructor(
    private readonly service: RiskService,
    private readonly employees: EmployeeService,
  ) {}

  @Get()
  @RequirePermission('risk.read')
  @ApiOperation({
    summary: 'The risk register, worst first',
    description:
      'Ordered by inherent score descending. `minInherentScore` narrows to what matters; ' +
      '`reviewDueOnBefore` gives the review queue for OPEN risks only. `search` matches the ' +
      'reference, title or category — not the description, which would match most of the register.',
  })
  @ApiPagedResponse(RiskResponseDto)
  @ApiCommonErrors(401, 403)
  async list(@Query() query: ListRisksQueryDto): Promise<PagedResult<RiskResponseDto>> {
    const { rows, total } = await this.service.listRisks(
      {
        status: query.status,
        category: query.category,
        ownerId: query.ownerId,
        assetId: query.assetId,
        reviewDueOnOrBefore: query.reviewDueOnOrBefore,
        minInherentScore: query.minInherentScore,
        search: query.search,
      },
      query.limit,
      query.offset,
    );
    return buildPageResult(rows.map(toRiskDto), total, query.limit, query.offset);
  }

  @Post()
  @RequirePermission('risk.manage')
  @ApiOperation({
    summary: 'Identify a risk',
    description:
      'Scores are `likelihood × impact` computed by the database, so only the factors are ' +
      'supplied and they must each be 1–5.',
  })
  @ApiCreatedResponse({ type: RiskResponseDto })
  @ApiCommonErrors(401, 403, 404, 409, 422)
  async identify(
    @Body() dto: IdentifyRiskDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<RiskResponseDto> {
    // `owner_id` carries no cross-schema FK, matching every other module, so without this a typo
    // would become a risk owned by nobody.
    await this.employees.assertExist(dto.ownerId);
    return toRiskDto(await this.service.identifyRisk(dto, user));
  }

  @Get(':id')
  @RequirePermission('risk.read')
  @ApiOperation({ summary: 'Get a risk' })
  @ApiOkResponse({ type: RiskResponseDto })
  @ApiCommonErrors(401, 403, 404)
  async getById(@Param('id', ParseUUIDPipe) id: string): Promise<RiskResponseDto> {
    // The read path, so it resolves the owner's name. `getRisk` is the write-path guard and stays
    // free of the lookup.
    return toRiskDto(await this.service.getRiskWithOwner(id));
  }

  @Patch(':id')
  @RequirePermission('risk.manage')
  @ApiOperation({
    summary: 'Change a risk, including re-scoring it',
    description:
      'Allowed in every state except `closed` — re-scoring an accepted risk is how a register ' +
      'stays honest, and the acceptance evidence stays attached.',
  })
  @ApiOkResponse({ type: RiskResponseDto })
  @ApiCommonErrors(401, 403, 404, 412, 422)
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRiskDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<RiskResponseDto> {
    await this.employees.assertExist(dto.ownerId);
    return toRiskDto(await this.service.updateRisk(id, dto, user));
  }

  @Post(':id/assess')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('risk.manage')
  @ApiOperation({
    summary: 'Record the treatment decision and the residual score',
    description: 'The residual score may not exceed the inherent one — treatment reduces risk.',
  })
  @ApiOkResponse({ type: RiskResponseDto })
  @ApiCommonErrors(401, 403, 404, 409, 412, 422)
  async assess(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssessRiskDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<RiskResponseDto> {
    return toRiskDto(await this.service.assessRisk(id, dto, user));
  }

  @Post(':id/treated')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('risk.manage')
  @ApiOperation({
    summary: 'Declare the treatment plan complete',
    description:
      'Refused while any treatment action is `planned` or `in_progress` ' +
      '(`RISK_TREATMENT_OUTSTANDING`) — "treated" is the claim an auditor checks first.',
  })
  @ApiOkResponse({ type: RiskResponseDto })
  @ApiCommonErrors(401, 403, 404, 409, 412, 422)
  async markTreated(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MarkTreatedDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<RiskResponseDto> {
    return toRiskDto(await this.service.markTreated(id, dto, user));
  }

  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('risk.manage')
  @ApiOperation({
    summary: 'Accept the residual risk',
    description:
      'Below the approval threshold this records the acceptance directly. At or above it, a ' +
      '`risk_acceptance` request is submitted and the risk is returned UNCHANGED — nothing is ' +
      'accepted until somebody holding `risk.accept` approves it, and it may not be the assessor.',
  })
  @ApiOkResponse({ type: AcceptRiskResponseDto })
  @ApiCommonErrors(401, 403, 404, 409, 412, 422)
  async accept(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AcceptRiskDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<AcceptRiskResponseDto> {
    const { risk, requestId } = await this.service.acceptRisk(id, dto, user);
    return { risk: toRiskDto(risk), requestId };
  }

  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('risk.manage')
  @ApiOperation({ summary: 'Close a risk — it no longer applies. The reason is required.' })
  @ApiOkResponse({ type: RiskResponseDto })
  @ApiCommonErrors(401, 403, 404, 409, 412, 422)
  async close(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CloseRiskDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<RiskResponseDto> {
    return toRiskDto(await this.service.closeRisk(id, dto.note, user));
  }

  // ── Treatments ───────────────────────────────────────────────────────────────

  @Get(':id/treatments')
  @RequirePermission('risk.read')
  @ApiOperation({ summary: 'Treatment actions for a risk, soonest due first' })
  @ApiOkResponse({ type: [RiskTreatmentResponseDto] })
  @ApiCommonErrors(401, 403, 404)
  async listTreatments(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<RiskTreatmentResponseDto[]> {
    return (await this.service.listTreatments(id)).map(toTreatmentDto);
  }

  @Post(':id/treatments')
  @RequirePermission('risk.manage')
  @ApiOperation({ summary: 'Add a treatment action' })
  @ApiCreatedResponse({ type: RiskTreatmentResponseDto })
  @ApiCommonErrors(401, 403, 404, 412, 422)
  async addTreatment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddTreatmentDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<RiskTreatmentResponseDto> {
    await this.employees.assertExist(dto.ownerId);
    return toTreatmentDto(await this.service.addTreatment({ ...dto, riskId: id }, user));
  }

  @Patch('treatments/:treatmentId')
  @RequirePermission('risk.manage')
  @ApiOperation({
    summary: 'Update a treatment action',
    description:
      'Setting the status to `done` fills `completedOn` with today when it is not supplied, and ' +
      'moving away from `done` clears it — `ck_treatment_done_evidence` pairs the two.',
  })
  @ApiOkResponse({ type: RiskTreatmentResponseDto })
  @ApiCommonErrors(401, 403, 404, 422)
  async updateTreatment(
    @Param('treatmentId', ParseUUIDPipe) treatmentId: string,
    @Body() dto: UpdateTreatmentDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<RiskTreatmentResponseDto> {
    await this.employees.assertExist(dto.ownerId);
    return toTreatmentDto(await this.service.updateTreatment(treatmentId, dto, user));
  }
}
