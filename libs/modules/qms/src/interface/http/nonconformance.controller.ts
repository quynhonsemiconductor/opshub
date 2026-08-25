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
  AuthorizedInService,
  RequirePermission,
  buildPageResult,
  type JwtPayload,
  type PagedResult,
} from '@platform';
import { EmployeeService } from '@modules/identity';
import { NonconformanceService } from '../../application/nonconformance.service';
import { CapaService } from '../../application/capa.service';
import type { Nonconformance, NonconformanceRow } from '../../domain/qms.types';
import {
  CapaResponseDto,
  CloseNonconformanceDto,
  ContainNonconformanceDto,
  ContainmentOverdueResponseDto,
  ListNonconformancesQueryDto,
  NonconformanceResponseDto,
  NonconformanceRowResponseDto,
  NonconformanceSeverityResponseDto,
  RaiseNonconformanceDto,
  RecurrenceSignalResponseDto,
  UpdateNonconformanceDto,
  VoidNonconformanceDto,
} from './dto/qms.dto';
import { toCapaDto } from './capa.controller';

/**
 * `ownerName` is OPTIONAL on the way in and always present on the way out.
 *
 * The read paths (`list`, `getRowById`) resolve it; the write paths do not, because their responses are
 * discarded by the SPA, which refetches — resolving there would be a directory query nobody reads.
 */
function toDto(n: Nonconformance & { ownerName?: string | null }): NonconformanceResponseDto {
  return {
    id: n.id,
    reference: n.reference,
    title: n.title,
    description: n.description,
    requirement: n.requirement,
    source: n.source,
    severity: n.severity,
    status: n.status,
    processArea: n.processArea,
    ownerId: n.ownerId,
    ownerName: n.ownerName ?? null,
    detectedAt: n.detectedAt.toISOString(),
    raisedBy: n.raisedBy,
    incidentId: n.incidentId,
    evidenceDocumentId: n.evidenceDocumentId,
    containmentAction: n.containmentAction,
    containedAt: n.containedAt?.toISOString() ?? null,
    closedAt: n.closedAt?.toISOString() ?? null,
    closureNote: n.closureNote,
    closedBy: n.closedBy,
    voidReason: n.voidReason,
    createdAt: n.createdAt.toISOString(),
  };
}

function toRowDto(
  r: NonconformanceRow & { ownerName?: string | null },
): NonconformanceRowResponseDto {
  return {
    ...toDto(r),
    severityRank: r.severityRank,
    requiresCapa: r.requiresCapa,
    containmentDueDays: r.containmentDueDays,
    capaCount: r.capaCount,
    verifiedCapaCount: r.verifiedCapaCount,
    containmentDueOn: r.containmentDueOn,
  };
}

@ApiTags('nonconformances')
@Controller('nonconformances')
@Auth()
export class NonconformanceController {
  constructor(
    private readonly service: NonconformanceService,
    private readonly capas: CapaService,
    private readonly employees: EmployeeService,
  ) {}

  // ── Static paths first ───────────────────────────────────────────────────────
  //
  // Declared before `:id`, because Nest matches in declaration order and `severities`
  // would otherwise be handed to the by-id route, where `ParseUUIDPipe` turns it into
  // a puzzling 400.

  @Get('severities')
  @RequirePermission('nonconformance.read')
  @ApiOperation({
    summary: 'The severity grades, their ranking and the policy each carries',
    description:
      'The RANK here is authoritative. `requiresCapa` is what the closure gate reads: a grade with ' +
      'it set cannot be closed until a corrective action has been verified effective.',
  })
  @ApiOkResponse({ type: [NonconformanceSeverityResponseDto] })
  @ApiCommonErrors(401, 403)
  async severities(): Promise<NonconformanceSeverityResponseDto[]> {
    return (await this.service.listSeverities()).map((g) => ({
      code: g.code,
      rank: g.rank,
      label: g.label,
      description: g.description,
      requiresCapa: g.requiresCapa,
      containmentDueDays: g.containmentDueDays,
    }));
  }

  @Get('reports/containment-overdue')
  @RequirePermission('nonconformance.read')
  @ApiOperation({
    summary: 'Findings past the containment deadline their grade allows',
    description:
      "Most overdue first. The deadline is `detectedAt + the grade's containmentDueDays`, derived " +
      'in one query so this report and the register column cannot disagree. Only findings still ' +
      '`open` appear: a contained one met the deadline by definition.',
  })
  @ApiOkResponse({ type: [ContainmentOverdueResponseDto] })
  @ApiCommonErrors(401, 403)
  async containmentOverdue(): Promise<ContainmentOverdueResponseDto[]> {
    return (await this.service.containmentOverdue()).map((r) => ({
      ...r,
      detectedAt: r.detectedAt.toISOString(),
    }));
  }

  @Get('reports/recurrence')
  @RequirePermission('nonconformance.read')
  @ApiOperation({
    summary: 'Process areas where findings recur despite a verified corrective action',
    description:
      'The report ISO 9001 §10.2(d) exists for. Two findings in one area is ordinary; a finding ' +
      'raised AFTER somebody signed off a fix for that area is evidence the effectiveness review ' +
      'was wrong. Nothing else in the system can say that, because it needs both dates.',
  })
  @ApiOkResponse({ type: [RecurrenceSignalResponseDto] })
  @ApiCommonErrors(401, 403)
  async recurrence(): Promise<RecurrenceSignalResponseDto[]> {
    return (await this.service.recurrenceSignals()).map((r) => ({
      ...r,
      latestDetectedAt: new Date(r.latestDetectedAt).toISOString(),
      earlierCapaVerifiedAt: new Date(r.earlierCapaVerifiedAt).toISOString(),
    }));
  }

  // ── The register ─────────────────────────────────────────────────────────────

  @Get()
  @RequirePermission('nonconformance.read')
  @ApiOperation({
    summary: 'The non-conformance register',
    description:
      'Worst grade first, then oldest detection — the order a work queue is read in. Each row ' +
      "carries its grade's policy, its CAPA counts and its containment deadline, resolved in the " +
      'same query.',
  })
  @ApiPagedResponse(NonconformanceRowResponseDto)
  @ApiCommonErrors(401, 403)
  async list(
    @Query() query: ListNonconformancesQueryDto,
  ): Promise<PagedResult<NonconformanceRowResponseDto>> {
    const { rows, total } = await this.service.list(
      {
        status: query.status,
        severity: query.severity,
        source: query.source,
        ownerId: query.ownerId,
        processArea: query.processArea,
        openOnly: query.openOnly,
        capaRequiredOnly: query.capaRequiredOnly,
        search: query.search,
      },
      query.limit,
      query.offset,
    );
    return buildPageResult(rows.map(toRowDto), total, query.limit, query.offset);
  }

  @Post('report')
  @AuthorizedInService(
    'any authenticated employee may raise a non-conformance — the raiser is taken from the token',
    'qms-nonconformance.e2e.spec.ts',
  )
  @ApiOperation({
    summary: 'Raise a non-conformance',
    description:
      'CARRIES NO PERMISSION BEYOND BEING AUTHENTICATED. A quality system where recording a process ' +
      'failure needs a role is one where failures go unrecorded — the same argument that keeps ' +
      'incident reporting open. Handling still requires `nonconformance.manage`. `raisedBy` comes ' +
      'from the token, never the payload.',
  })
  @ApiCreatedResponse({ type: NonconformanceResponseDto })
  @ApiCommonErrors(400, 401, 404, 409, 412)
  async report(
    @Body() dto: RaiseNonconformanceDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<NonconformanceResponseDto> {
    // `owner_id` carries no cross-schema FK, so without this a typo would name nobody.
    await this.employees.assertExist(dto.ownerId);
    return toDto(await this.service.raise(dto, user));
  }

  @Get(':id')
  @RequirePermission('nonconformance.read')
  @ApiOperation({ summary: 'One finding' })
  // The ROW shape, the same one the register lists. A detail view that omitted `requiresCapa` and
  // `verifiedCapaCount` could not say whether the finding it was showing may close — which is the one
  // question a reader opens a finding to answer.
  @ApiOkResponse({ type: NonconformanceRowResponseDto })
  @ApiCommonErrors(401, 403, 404)
  async getOne(@Param('id', ParseUUIDPipe) id: string): Promise<NonconformanceRowResponseDto> {
    return toRowDto(await this.service.getRowById(id));
  }

  @Patch(':id')
  @RequirePermission('nonconformance.manage')
  @ApiOperation({
    summary: 'Correct a finding, including its grade',
    description:
      'The status is NOT settable here — closing through a patch would skip the CAPA gate. ' +
      'Re-grading IS allowed: it is ordinary work on better information, and the gate then reads ' +
      'the new grade, which is what makes re-grading meaningful.',
  })
  @ApiOkResponse({ type: NonconformanceResponseDto })
  @ApiCommonErrors(400, 401, 403, 404, 412)
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateNonconformanceDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<NonconformanceResponseDto> {
    await this.employees.assertExist(dto.ownerId);
    return toDto(await this.service.update(id, dto, user));
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  @Post(':id/contain')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('nonconformance.manage')
  @ApiOperation({
    summary: 'Record the immediate fix',
    description:
      'The containment action is required — a contained finding with no action describes nothing.',
  })
  @ApiOkResponse({ type: NonconformanceResponseDto })
  @ApiCommonErrors(400, 401, 403, 404, 409, 412)
  async contain(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ContainNonconformanceDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<NonconformanceResponseDto> {
    return toDto(await this.service.contain(id, dto.containmentAction, dto.containedAt, user));
  }

  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('nonconformance.manage')
  @ApiOperation({
    summary: 'Close a finding',
    description:
      'THE GATE: a grade whose `requiresCapa` is set cannot be closed until a corrective action ' +
      'against it has been verified effective (ISO 9001 §10.2(d)), and the answer is a coded 412 ' +
      'rather than a silent success. A grade without it closes on its containment and closure note.',
  })
  @ApiOkResponse({ type: NonconformanceResponseDto })
  @ApiCommonErrors(400, 401, 403, 404, 409, 412)
  async close(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CloseNonconformanceDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<NonconformanceResponseDto> {
    return toDto(await this.service.close(id, dto.closureNote, user));
  }

  @Post(':id/void')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('nonconformance.manage')
  @ApiOperation({
    summary: 'Mark a finding as raised in error',
    description:
      'Kept rather than deleted: "we looked and there was nothing wrong" is a record an auditor may ' +
      'ask about. Refused once a containment action exists — containing something is saying it was ' +
      'real.',
  })
  @ApiOkResponse({ type: NonconformanceResponseDto })
  @ApiCommonErrors(400, 401, 403, 404, 409, 412)
  async voidFinding(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VoidNonconformanceDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<NonconformanceResponseDto> {
    return toDto(await this.service.void(id, dto.reason, user));
  }

  // ── Its corrective actions ───────────────────────────────────────────────────

  @Get(':id/capas')
  @RequirePermission('nonconformance.read')
  @ApiOperation({
    summary: 'Corrective actions against this finding, newest first',
    description:
      'Guarded by `nonconformance.read` and not a separate `capa.read`: a CAPA only ever exists ' +
      'against a finding, so anybody who may read the finding may read what was done about it.',
  })
  @ApiOkResponse({ type: [CapaResponseDto] })
  @ApiCommonErrors(401, 403, 404)
  async capasFor(@Param('id', ParseUUIDPipe) id: string): Promise<CapaResponseDto[]> {
    // NOT annotated `Capa[]`: that widening threw away the `ownerName` the service resolves, and
    // `toCapaDto` would then have emitted null for it on this path alone — the finding's drawer and
    // the CAPA queue render the same card, so it would have looked like a card stuck loading.
    const rows = await this.capas.listForNonconformance(id);
    // The CAPA controller's own mapper, imported rather than reimplemented.
    return rows.map(toCapaDto);
  }
}
