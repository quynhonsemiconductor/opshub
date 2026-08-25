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
  ApiPagedResponse,
  Auth,
  CurrentUser,
  RequirePermission,
  buildPageResult,
  type JwtPayload,
  type PagedResult,
} from '@platform';
import { EmployeeService } from '@modules/identity';
import { CapaService } from '../../application/capa.service';
import type { Capa, CapaRow } from '../../domain/qms.types';
import {
  CapaAnalysisDto,
  CapaOutcomeDto,
  CapaResponseDto,
  CapaRowResponseDto,
  ListCapasQueryDto,
  MarkImplementedDto,
  OpenCapaDto,
  VerifyCapaDto,
} from './dto/qms.dto';

/**
 * Exported so the non-conformance controller can render a finding's CAPAs with the SAME shape.
 *
 * A second mapper is how one of them silently stops emitting a field a screen reads.
 *
 * `ownerName` is optional on the way in and always present on the way out: the read paths resolve it,
 * the transition routes do not, because the SPA throws their responses away and refetches.
 */
export function toCapaDto(c: Capa & { ownerName?: string | null }): CapaResponseDto {
  return {
    id: c.id,
    reference: c.reference,
    nonconformanceId: c.nonconformanceId,
    status: c.status,
    ownerId: c.ownerId,
    ownerName: c.ownerName ?? null,
    rootCause: c.rootCause,
    rootCauseMethod: c.rootCauseMethod,
    actionPlan: c.actionPlan,
    dueOn: c.dueOn,
    implementedAt: c.implementedAt?.toISOString() ?? null,
    verifiedAt: c.verifiedAt?.toISOString() ?? null,
    verifiedBy: c.verifiedBy,
    effectivenessEvidence: c.effectivenessEvidence,
    outcomeNote: c.outcomeNote,
    createdAt: c.createdAt.toISOString(),
  };
}

function toRowDto(r: CapaRow & { ownerName?: string | null }): CapaRowResponseDto {
  return {
    ...toCapaDto(r),
    nonconformanceReference: r.nonconformanceReference,
    nonconformanceTitle: r.nonconformanceTitle,
    nonconformanceSeverity: r.nonconformanceSeverity,
  };
}

@ApiTags('capas')
@Controller('capas')
@Auth()
export class CapaController {
  constructor(
    private readonly service: CapaService,
    private readonly employees: EmployeeService,
  ) {}

  @Get()
  @RequirePermission('nonconformance.read')
  @ApiOperation({
    summary: 'Corrective actions',
    description:
      'Soonest due first, undated last — the order a work queue is read in. Each row carries the ' +
      'finding it answers, so a list needs no second round trip. Guarded by `nonconformance.read`: ' +
      'there is deliberately no `capa.read`, because a CAPA only exists against a finding.',
  })
  @ApiPagedResponse(CapaRowResponseDto)
  @ApiCommonErrors(401, 403)
  async list(@Query() query: ListCapasQueryDto): Promise<PagedResult<CapaRowResponseDto>> {
    const { rows, total } = await this.service.list(
      {
        status: query.status,
        ownerId: query.ownerId,
        nonconformanceId: query.nonconformanceId,
        openOnly: query.openOnly,
        dueOnOrBefore: query.dueOnOrBefore,
      },
      query.limit,
      query.offset,
    );
    return buildPageResult(rows.map(toRowDto), total, query.limit, query.offset);
  }

  @Post('for/:nonconformanceId')
  @RequirePermission('capa.manage')
  @ApiOperation({
    summary: 'Open a corrective action against a finding',
    description:
      'Mounted under the FINDING because a CAPA cannot exist without one — `nonconformance_id` is ' +
      'NOT NULL. Opens in `analysis`: the root cause comes next, and the CAPA cannot be planned ' +
      'until it is recorded. Refused once the finding is closed or void, since there is nothing ' +
      'left to correct.',
  })
  @ApiCreatedResponse({ type: CapaResponseDto })
  @ApiCommonErrors(400, 401, 403, 404, 409, 412)
  async open(
    @Param('nonconformanceId', ParseUUIDPipe) nonconformanceId: string,
    @Body() dto: OpenCapaDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<CapaResponseDto> {
    await this.employees.assertExist(dto.ownerId);
    return toCapaDto(await this.service.open(nonconformanceId, dto, user));
  }

  @Get(':id')
  @RequirePermission('nonconformance.read')
  @ApiOperation({ summary: 'One corrective action' })
  @ApiOkResponse({ type: CapaResponseDto })
  @ApiCommonErrors(401, 403, 404)
  async getOne(@Param('id', ParseUUIDPipe) id: string): Promise<CapaResponseDto> {
    // `getWithOwner`, not `getById` — see its docblock for why the guard the transitions share was not
    // widened to do this.
    return toCapaDto(await this.service.getWithOwner(id));
  }

  @Post(':id/analysis')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('capa.manage')
  @ApiOperation({
    summary: 'Record the root cause, the method behind it, and the plan',
    description:
      'All three together: a cause with no method is an assertion, and a plan built on no stated ' +
      'cause is a guess. Accepted only while the CAPA is in `analysis` — including the `analysis` a ' +
      'failed effectiveness review returned it to, which is how a second attempt records a ' +
      "different cause without touching the first attempt's evidence.",
  })
  @ApiOkResponse({ type: CapaResponseDto })
  @ApiCommonErrors(400, 401, 403, 404, 412)
  async recordAnalysis(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CapaAnalysisDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<CapaResponseDto> {
    return toCapaDto(await this.service.recordAnalysis(id, dto, user));
  }

  @Post(':id/plan')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('capa.manage')
  @ApiOperation({
    summary: 'Accept the plan',
    description: 'Refuses until the analysis is complete, naming the fields that are missing.',
  })
  @ApiOkResponse({ type: CapaResponseDto })
  @ApiCommonErrors(401, 403, 404, 409, 412)
  async plan(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<CapaResponseDto> {
    return toCapaDto(await this.service.plan(id, user));
  }

  @Post(':id/start')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('capa.manage')
  @ApiOperation({ summary: 'Begin the work' })
  @ApiOkResponse({ type: CapaResponseDto })
  @ApiCommonErrors(401, 403, 404, 409, 412)
  async start(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<CapaResponseDto> {
    return toCapaDto(await this.service.start(id, user));
  }

  @Post(':id/implemented')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('capa.manage')
  @ApiOperation({
    summary: 'Record that the actions are done',
    description: 'Done, not proven — whether it worked is the effectiveness review below.',
  })
  @ApiOkResponse({ type: CapaResponseDto })
  @ApiCommonErrors(400, 401, 403, 404, 409, 412)
  async markImplemented(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MarkImplementedDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<CapaResponseDto> {
    return toCapaDto(await this.service.markImplemented(id, dto.implementedAt, user));
  }

  @Post(':id/verify')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('capa.verify')
  @ApiOperation({
    summary: 'Sign off that the action was effective (ISO 9001 §10.2(d))',
    description:
      'THE LOAD-BEARING SIGNATURE: verifying is what unlocks closing a major finding. Needs ' +
      '`capa.verify`, which is in no default role bundle — like `risk.accept`, ' +
      '`information_asset.declassify` and `vendor.approve`. The service ALSO refuses a verifier who ' +
      'owns the CAPA: the permission says who may sign, and that rule is what makes the signature ' +
      'a review rather than a formality.',
  })
  @ApiOkResponse({ type: CapaResponseDto })
  @ApiCommonErrors(400, 401, 403, 404, 409, 412)
  async verify(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VerifyCapaDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<CapaResponseDto> {
    return toCapaDto(await this.service.verify(id, dto.effectivenessEvidence, user));
  }

  @Post(':id/ineffective')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('capa.verify')
  @ApiOperation({
    summary: 'Record that the action did NOT work',
    description:
      'Not terminal — it returns the CAPA to `analysis`, and the finding stays open because no ' +
      'verified CAPA exists. This is the path that makes the effectiveness review mean something: a ' +
      'review that can only pass is not a review. Refused to the CAPA owner in this direction too.',
  })
  @ApiOkResponse({ type: CapaResponseDto })
  @ApiCommonErrors(400, 401, 403, 404, 409, 412)
  async markIneffective(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CapaOutcomeDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<CapaResponseDto> {
    return toCapaDto(await this.service.markIneffective(id, dto.reason, user));
  }

  @Post(':id/reopen-analysis')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('capa.manage')
  @ApiOperation({
    summary: 'Return a failed action to analysis so a different cause can be recorded',
    description:
      'Legal only from `ineffective`. `verified` is terminal: a CAPA that needs revisiting after ' +
      'sign-off is a NEW CAPA against the same finding, because re-opening the old one would ' +
      'overwrite the evidence somebody relied on.',
  })
  @ApiOkResponse({ type: CapaResponseDto })
  @ApiCommonErrors(401, 403, 404, 409, 412)
  async reopenAnalysis(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<CapaResponseDto> {
    return toCapaDto(await this.service.reopenAnalysis(id, user));
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('capa.manage')
  @ApiOperation({
    summary: 'Abandon the action',
    description:
      'Terminal, and it does NOT close the finding: a cancelled CAPA is not a verified one, so a ' +
      'major finding stays open until another action is verified effective.',
  })
  @ApiOkResponse({ type: CapaResponseDto })
  @ApiCommonErrors(400, 401, 403, 404, 409, 412)
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CapaOutcomeDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<CapaResponseDto> {
    return toCapaDto(await this.service.cancel(id, dto.reason, user));
  }
}
