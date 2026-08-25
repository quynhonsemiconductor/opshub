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
import { ControlService } from '../../application/control.service';
import type {
  Control,
  SoaCoverage,
  SoaEntry,
  SoaRow,
  UntreatedRisk,
} from '../../domain/control.types';
import {
  ControlResponseDto,
  CreateControlDto,
  LinkedControlResponseDto,
  LinkedRiskResponseDto,
  ListControlsQueryDto,
  ListSoaQueryDto,
  MarkReviewedDto,
  SetSoaEntryDto,
  SoaCoverageResponseDto,
  SoaEntryResponseDto,
  SoaRowResponseDto,
  UntreatedRiskResponseDto,
  UpdateControlDto,
} from './dto/control.dto';

function toControlDto(c: Control): ControlResponseDto {
  return {
    id: c.id,
    reference: c.reference,
    title: c.title,
    description: c.description,
    theme: c.theme,
    source: c.source,
    retiredAt: c.retiredAt?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
  };
}

function toEntryDto(e: SoaEntry & { ownerName?: string | null }): SoaEntryResponseDto {
  return {
    id: e.id,
    controlId: e.controlId,
    applicable: e.applicable,
    justification: e.justification,
    status: e.status,
    implementationNote: e.implementationNote,
    evidenceDocumentId: e.evidenceDocumentId,
    ownerId: e.ownerId,
    // Absent when the statement was just written or a review was just stamped, neither of which
    // renders an owner — see `SoaEntryResponseDto.ownerName`. Never `?? e.ownerId`.
    ownerName: e.ownerName ?? null,
    lastReviewedAt: e.lastReviewedAt?.toISOString() ?? null,
    reviewDueOn: e.reviewDueOn,
  };
}

function toRowDto(r: SoaRow & { ownerName?: string | null }): SoaRowResponseDto {
  return {
    ...toEntryDto(r),
    controlReference: r.controlReference,
    controlTitle: r.controlTitle,
    controlTheme: r.controlTheme,
  };
}

@ApiTags('controls')
@Controller('controls')
@Auth()
export class ControlController {
  constructor(
    private readonly service: ControlService,
    private readonly employees: EmployeeService,
  ) {}

  // ── The Statement of Applicability ───────────────────────────────────────────
  //
  // First, because it is the document an ISO 27001 audit asks for before anything else.

  @Get('soa')
  @RequirePermission('control.read')
  @ApiOperation({
    summary: 'The Statement of Applicability',
    description:
      'One row per control that has been DECIDED about. Controls with no entry are absent by ' +
      'design — that state is what `undecided` in the coverage summary counts.',
  })
  @ApiPagedResponse(SoaRowResponseDto)
  @ApiCommonErrors(401, 403)
  async listSoa(@Query() query: ListSoaQueryDto): Promise<PagedResult<SoaRowResponseDto>> {
    const { rows, total } = await this.service.listEntries(
      {
        applicable: query.applicable,
        status: query.status,
        ownerId: query.ownerId,
        theme: query.theme,
        reviewDueOnOrBefore: query.reviewDueOnOrBefore,
      },
      query.limit,
      query.offset,
    );
    return buildPageResult(rows.map(toRowDto), total, query.limit, query.offset);
  }

  @Get('soa/coverage')
  @RequirePermission('control.read')
  @ApiOperation({
    summary: 'SoA coverage — the number an audit opens with',
    description:
      '`undecided` counts controls with no entry at all. Retired controls are excluded: they are ' +
      'not part of the statement anybody is working from.',
  })
  @ApiOkResponse({ type: SoaCoverageResponseDto })
  @ApiCommonErrors(401, 403)
  async coverage(): Promise<SoaCoverage> {
    return this.service.coverage();
  }

  @Get('soa/untreated-risks')
  @RequirePermission('control.read')
  @ApiOperation({
    summary: 'Open risks that no control treats',
    description: 'Worst first. The gap the risk↔control link exists to expose.',
  })
  @ApiOkResponse({ type: [UntreatedRiskResponseDto] })
  @ApiCommonErrors(401, 403)
  async untreated(): Promise<UntreatedRisk[]> {
    return this.service.untreatedRisks();
  }

  @Get('soa/:controlId')
  @RequirePermission('control.read')
  @ApiOperation({
    summary: 'The decision about one control',
    description:
      '404 when no decision has been recorded yet — which is a real state, not an error.',
  })
  @ApiOkResponse({ type: SoaEntryResponseDto })
  @ApiCommonErrors(401, 403, 404)
  async getEntry(
    @Param('controlId', ParseUUIDPipe) controlId: string,
  ): Promise<SoaEntryResponseDto> {
    // The read path, so it resolves the owner's name. `getEntry` is the guard `markReviewed` calls
    // and stays free of the lookup.
    return toEntryDto(await this.service.getEntryWithOwner(controlId));
  }

  @Put('soa/:controlId')
  @RequirePermission('control.manage')
  @ApiOperation({
    summary: 'Record the decision about one control',
    description:
      'PUT, not PATCH: applicability, justification and status are ONE statement, and changing ' +
      'them independently is how an entry ends up excluded with a rationale arguing for ' +
      'inclusion. An excluded control must carry status `not_applicable` (`SOA_INCONSISTENT`).',
  })
  @ApiOkResponse({ type: SoaEntryResponseDto })
  @ApiCommonErrors(401, 403, 404, 412, 422)
  async setEntry(
    @Param('controlId', ParseUUIDPipe) controlId: string,
    @Body() dto: SetSoaEntryDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<SoaEntryResponseDto> {
    // `owner_id` carries no cross-schema FK, so without this a typo would name nobody.
    await this.employees.assertExist(dto.ownerId);
    return toEntryDto(await this.service.setEntry(controlId, dto, user));
  }

  @Post('soa/:controlId/reviewed')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('control.manage')
  @ApiOperation({
    summary: 'Record that the entry has been reviewed',
    description: 'Stamps `lastReviewedAt`. Supply `reviewDueOn` to schedule the next one.',
  })
  @ApiOkResponse({ type: SoaEntryResponseDto })
  @ApiCommonErrors(401, 403, 404, 422)
  async markReviewed(
    @Param('controlId', ParseUUIDPipe) controlId: string,
    @Body() dto: MarkReviewedDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<SoaEntryResponseDto> {
    return toEntryDto(await this.service.markReviewed(controlId, dto.reviewDueOn ?? null, user));
  }

  // ── The catalogue ────────────────────────────────────────────────────────────

  @Get()
  @RequirePermission('control.read')
  @ApiOperation({
    summary: 'The control catalogue',
    description: 'Retired controls are hidden unless `includeRetired` is set.',
  })
  @ApiPagedResponse(ControlResponseDto)
  @ApiCommonErrors(401, 403)
  async list(@Query() query: ListControlsQueryDto): Promise<PagedResult<ControlResponseDto>> {
    const { rows, total } = await this.service.listControls(
      { theme: query.theme, source: query.source, includeRetired: query.includeRetired },
      query.limit,
      query.offset,
    );
    return buildPageResult(rows.map(toControlDto), total, query.limit, query.offset);
  }

  @Post()
  @RequirePermission('control.manage')
  @ApiOperation({
    summary: 'Add a control',
    description:
      'For an organisation-specific control, set `source: custom` — ISO 27001 permits additions ' +
      'beyond Annex A, and the SoA has to state that Annex A was compared against.',
  })
  @ApiCreatedResponse({ type: ControlResponseDto })
  @ApiCommonErrors(401, 403, 409, 422)
  async create(
    @Body() dto: CreateControlDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<ControlResponseDto> {
    return toControlDto(await this.service.createControl(dto, user));
  }

  @Get(':id')
  @RequirePermission('control.read')
  @ApiOperation({ summary: 'Get a control' })
  @ApiOkResponse({ type: ControlResponseDto })
  @ApiCommonErrors(401, 403, 404)
  async getById(@Param('id', ParseUUIDPipe) id: string): Promise<ControlResponseDto> {
    return toControlDto(await this.service.getControl(id));
  }

  @Patch(':id')
  @RequirePermission('control.manage')
  @ApiOperation({ summary: 'Change a control' })
  @ApiOkResponse({ type: ControlResponseDto })
  @ApiCommonErrors(401, 403, 404, 422)
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateControlDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<ControlResponseDto> {
    return toControlDto(await this.service.updateControl(id, dto, user));
  }

  @Post(':id/retire')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('control.manage')
  @ApiOperation({
    summary: 'Retire a control',
    description:
      'It stays in the catalogue — an SoA entry from a past audit references it — but accepts no ' +
      'new decision and no new risk link.',
  })
  @ApiOkResponse({ type: ControlResponseDto })
  @ApiCommonErrors(401, 403, 404, 412)
  async retire(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<ControlResponseDto> {
    return toControlDto(await this.service.retireControl(id, user));
  }

  @Get(':id/risks')
  @RequirePermission('control.read')
  @ApiOperation({ summary: 'Risks this control treats' })
  @ApiOkResponse({ type: [LinkedRiskResponseDto] })
  @ApiCommonErrors(401, 403, 404)
  async risksForControl(@Param('id', ParseUUIDPipe) id: string): Promise<LinkedRiskResponseDto[]> {
    return this.service.listRisksForControl(id);
  }
}

/**
 * The risk side of the link, mounted under `/risks` because that is the resource being modified.
 *
 * A separate controller rather than more routes on `RiskController`: the link is this module's
 * concern and `ControlService` owns it, so putting it here keeps one service per controller while
 * the URL still reads from the caller's point of view.
 */
@ApiTags('risks')
@Controller('risks')
@Auth()
export class RiskControlController {
  constructor(private readonly service: ControlService) {}

  @Get(':id/controls')
  @RequirePermission('risk.read')
  @ApiOperation({
    summary: 'Controls treating this risk',
    description: "`status` is the control's SoA status, or null when no decision exists yet.",
  })
  @ApiOkResponse({ type: [LinkedControlResponseDto] })
  @ApiCommonErrors(401, 403, 404)
  async list(@Param('id', ParseUUIDPipe) id: string): Promise<LinkedControlResponseDto[]> {
    return (await this.service.listControlsForRisk(id)).map((c) => ({
      ...toControlDto(c),
      status: c.status,
    }));
  }

  @Put(':id/controls/:controlId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('risk.manage')
  @ApiOperation({
    summary: 'Assign a control to treat this risk',
    description: 'Idempotent — the pair is the natural key, so linking twice is still one link.',
  })
  @ApiCommonErrors(401, 403, 404, 412)
  async link(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('controlId', ParseUUIDPipe) controlId: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<void> {
    await this.service.linkRisk(id, controlId, user);
  }

  @Delete(':id/controls/:controlId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('risk.manage')
  @ApiOperation({ summary: 'Stop treating this risk with that control' })
  @ApiCommonErrors(401, 403, 404)
  async unlink(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('controlId', ParseUUIDPipe) controlId: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<void> {
    await this.service.unlinkRisk(id, controlId, user);
  }
}
