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
import { InformationAssetService } from '../../application/information-asset.service';
import type {
  ClassificationChange,
  InformationAsset,
  InformationAssetRow,
} from '../../domain/information-asset.types';
import {
  ClassificationChangeResponseDto,
  ClassificationLevelResponseDto,
  ClassificationSummaryResponseDto,
  DeviceHoldingResponseDto,
  InformationAssetDeviceResponseDto,
  InformationAssetResponseDto,
  InformationAssetRowResponseDto,
  ListInformationAssetsQueryDto,
  MarkAssetReviewedDto,
  ReclassifyDto,
  RegisterInformationAssetDto,
  UpdateInformationAssetDto,
} from './dto/information-asset.dto';

function toDto(
  a: InformationAsset & { ownerName?: string | null; custodianName?: string | null },
): InformationAssetResponseDto {
  return {
    id: a.id,
    reference: a.reference,
    name: a.name,
    description: a.description,
    type: a.type,
    classification: a.classification,
    ownerId: a.ownerId,
    // Absent on the write paths, which nothing renders — see `InformationAssetResponseDto.ownerName`.
    // Never `?? a.ownerId`: that puts the uuid straight back.
    ownerName: a.ownerName ?? null,
    custodianId: a.custodianId,
    custodianName: a.custodianName ?? null,
    confidentiality: a.confidentiality,
    integrity: a.integrity,
    availability: a.availability,
    personalData: a.personalData,
    location: a.location,
    retentionMonths: a.retentionMonths,
    lastReviewedAt: a.lastReviewedAt?.toISOString() ?? null,
    reviewDueOn: a.reviewDueOn,
    retiredAt: a.retiredAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
  };
}

function toRowDto(
  r: InformationAssetRow & { ownerName?: string | null; custodianName?: string | null },
): InformationAssetRowResponseDto {
  return {
    ...toDto(r),
    classificationRank: r.classificationRank,
    encryptionRequired: r.encryptionRequired,
    deviceCount: r.deviceCount,
  };
}

function toChangeDto(c: ClassificationChange): ClassificationChangeResponseDto {
  return {
    id: c.id,
    informationAssetId: c.informationAssetId,
    fromLevel: c.fromLevel,
    toLevel: c.toLevel,
    reason: c.reason,
    changedBy: c.changedBy,
    changedAt: c.changedAt.toISOString(),
  };
}

@ApiTags('information-assets')
@Controller('information-assets')
@Auth()
export class InformationAssetController {
  constructor(
    private readonly service: InformationAssetService,
    private readonly employees: EmployeeService,
  ) {}

  // ── Static paths first ───────────────────────────────────────────────────────
  //
  // Declared before `:id`, because Nest matches in declaration order and
  // `classification-levels` would otherwise be handed to the by-id route, where
  // `ParseUUIDPipe` turns it into a puzzling 400.

  @Get('classification-levels')
  @RequirePermission('information_asset.read')
  @ApiOperation({
    summary: 'The classification labels, their ranking and the handling each demands',
    description:
      'The RANK here is authoritative. Nothing should infer the ordering from the order the ' +
      'labels happen to appear in, in this response or anywhere else.',
  })
  @ApiOkResponse({ type: [ClassificationLevelResponseDto] })
  @ApiCommonErrors(401, 403)
  async levels(): Promise<ClassificationLevelResponseDto[]> {
    return (await this.service.listLevels()).map((l) => ({
      code: l.code,
      rank: l.rank,
      label: l.label,
      handlingRules: l.handlingRules,
      encryptionRequired: l.encryptionRequired,
    }));
  }

  @Get('reports/classification-summary')
  @RequirePermission('information_asset.read')
  @ApiOperation({
    summary: 'The register by classification',
    description:
      'One line per level, including levels holding nothing — "we hold nothing restricted" is an ' +
      'answer worth printing. Retired assets are excluded: this is the current inventory.',
  })
  @ApiOkResponse({ type: [ClassificationSummaryResponseDto] })
  @ApiCommonErrors(401, 403)
  async summary(): Promise<ClassificationSummaryResponseDto[]> {
    return this.service.classificationSummary();
  }

  @Get('reports/device-holdings/:deviceAssetId')
  @RequirePermission('information_asset.read')
  @ApiOperation({
    summary: 'What one device holds, worst classification first',
    description:
      'The question asked the moment a laptop is reported lost or stolen. Takes a DEVICE id from ' +
      'the hardware inventory. An empty list means nothing registered was held on it — which is ' +
      'deliberately distinguishable from a 404 the caller would have to interpret.',
  })
  @ApiOkResponse({ type: [DeviceHoldingResponseDto] })
  @ApiCommonErrors(401, 403)
  async deviceHoldings(
    @Param('deviceAssetId', ParseUUIDPipe) deviceAssetId: string,
  ): Promise<DeviceHoldingResponseDto[]> {
    return this.service.holdingsOnDevice(deviceAssetId);
  }

  // ── The register ─────────────────────────────────────────────────────────────

  @Get()
  @RequirePermission('information_asset.read')
  @ApiOperation({
    summary: 'The information asset register',
    description:
      'Most protected first. `ownerId` matches the owner OR the custodian. Retired assets are ' +
      'excluded unless `includeRetired` is set, because the register means the current inventory.',
  })
  @ApiPagedResponse(InformationAssetRowResponseDto)
  @ApiCommonErrors(401, 403)
  async list(
    @Query() query: ListInformationAssetsQueryDto,
  ): Promise<PagedResult<InformationAssetRowResponseDto>> {
    const { rows, total } = await this.service.list(
      {
        type: query.type,
        classification: query.classification,
        ownerId: query.ownerId,
        personalDataOnly: query.personalDataOnly,
        reviewDueOnOrBefore: query.reviewDueOnOrBefore,
        includeRetired: query.includeRetired,
        search: query.search,
      },
      query.limit,
      query.offset,
    );
    return buildPageResult(rows.map(toRowDto), total, query.limit, query.offset);
  }

  @Post()
  @RequirePermission('information_asset.manage')
  @ApiOperation({
    summary: 'Register an information asset and classify it',
    description:
      'The classification and the reason for it are both required: the reason becomes the first ' +
      'row of the classification history, which is what lets the current label be accounted for.',
  })
  @ApiCreatedResponse({ type: InformationAssetResponseDto })
  @ApiCommonErrors(400, 401, 403, 404, 409, 412)
  async register(
    @Body() dto: RegisterInformationAssetDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<InformationAssetResponseDto> {
    // `owner_id` and `custodian_id` carry no cross-schema FK, so without this a typo names nobody.
    await this.employees.assertExist(dto.ownerId, dto.custodianId);
    return toDto(await this.service.register(dto, user));
  }

  @Get(':id')
  @RequirePermission('information_asset.read')
  @ApiOperation({ summary: 'One information asset' })
  @ApiOkResponse({ type: InformationAssetResponseDto })
  @ApiCommonErrors(401, 403, 404)
  async getOne(@Param('id', ParseUUIDPipe) id: string): Promise<InformationAssetResponseDto> {
    // The read path, so it resolves the owner's name. `getById` is the write-path guard and stays
    // free of the lookup.
    return toDto(await this.service.getByIdWithOwner(id));
  }

  @Patch(':id')
  @RequirePermission('information_asset.manage')
  @ApiOperation({
    summary: 'Correct an asset and its CIA rating',
    description:
      'The classification is NOT settable here — see `reclassify` and `declassify`, which write ' +
      'history and, downwards, need a separate permission.',
  })
  @ApiOkResponse({ type: InformationAssetResponseDto })
  @ApiCommonErrors(400, 401, 403, 404, 412)
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateInformationAssetDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<InformationAssetResponseDto> {
    await this.employees.assertExist(dto.ownerId, dto.custodianId);
    return toDto(await this.service.update(id, dto, user));
  }

  // ── Classification ───────────────────────────────────────────────────────────

  @Post(':id/reclassify')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('information_asset.manage')
  @ApiOperation({
    summary: 'Raise the classification',
    description:
      'Refuses a REDUCTION with `INFORMATION_ASSET_DECLASSIFY_REQUIRED`. Lowering protection goes ' +
      'through `declassify`, which needs `information_asset.declassify` — the split exists so that ' +
      'holding `manage` does not silently include the power to make information easier to reach.',
  })
  @ApiOkResponse({ type: InformationAssetResponseDto })
  @ApiCommonErrors(400, 401, 403, 404, 409, 412)
  async reclassify(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReclassifyDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<InformationAssetResponseDto> {
    return toDto(await this.service.reclassify(id, dto.classification, dto.reason, user));
  }

  @Post(':id/declassify')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('information_asset.declassify')
  @ApiOperation({
    summary: 'Lower the classification',
    description:
      'The only route that will reduce protection. Held by nobody by default — like `risk.accept`, ' +
      '`information_asset.declassify` is in no role bundle and is granted deliberately. The reason ' +
      'is recorded in the history and the change is audited as its own action.',
  })
  @ApiOkResponse({ type: InformationAssetResponseDto })
  @ApiCommonErrors(400, 401, 403, 404, 409, 412)
  async declassify(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReclassifyDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<InformationAssetResponseDto> {
    return toDto(await this.service.declassify(id, dto.classification, dto.reason, user));
  }

  @Get(':id/classification-history')
  @RequirePermission('information_asset.read')
  @ApiOperation({
    summary: 'Every classification this asset has carried, and why',
    description:
      'Oldest first. The first row has a null `fromLevel` — that is the asset being classified ' +
      'when it was registered. Append-only: the application holds no privilege to update or ' +
      'delete these rows.',
  })
  @ApiOkResponse({ type: [ClassificationChangeResponseDto] })
  @ApiCommonErrors(401, 403, 404)
  async history(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ClassificationChangeResponseDto[]> {
    return (await this.service.listChanges(id)).map(toChangeDto);
  }

  // ── Review and retirement ────────────────────────────────────────────────────

  @Post(':id/reviewed')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('information_asset.manage')
  @ApiOperation({ summary: 'Record that the entry has been reviewed' })
  @ApiOkResponse({ type: InformationAssetResponseDto })
  @ApiCommonErrors(400, 401, 403, 404)
  async markReviewed(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MarkAssetReviewedDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<InformationAssetResponseDto> {
    return toDto(await this.service.markReviewed(id, dto.reviewDueOn ?? null, user));
  }

  @Post(':id/retire')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('information_asset.manage')
  @ApiOperation({
    summary: 'Retire an asset',
    description:
      'The row stays, with its history and device links: a risk assessment and an incident from ' +
      'last year reference it. Retired assets accept no further changes.',
  })
  @ApiOkResponse({ type: InformationAssetResponseDto })
  @ApiCommonErrors(401, 403, 404, 412)
  async retire(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<InformationAssetResponseDto> {
    return toDto(await this.service.retire(id, user));
  }

  // ── Devices ──────────────────────────────────────────────────────────────────

  @Get(':id/devices')
  @RequirePermission('information_asset.read')
  @ApiOperation({ summary: 'The devices recorded as holding this information asset' })
  @ApiOkResponse({ type: [InformationAssetDeviceResponseDto] })
  @ApiCommonErrors(401, 403, 404)
  async devices(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<InformationAssetDeviceResponseDto[]> {
    return this.service.listDevices(id);
  }

  @Put(':id/devices/:deviceAssetId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('information_asset.manage')
  @ApiOperation({
    summary: 'Record that a device holds this information asset',
    description:
      'Idempotent — the pair is the natural key, so linking twice is still one link. The device ' +
      'cannot then be deleted from the inventory while the link stands, which is deliberate: ' +
      '"we disposed of the laptop" is the moment somebody should be asked what was on it.',
  })
  @ApiCommonErrors(401, 403, 404, 412)
  async linkDevice(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('deviceAssetId', ParseUUIDPipe) deviceAssetId: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<void> {
    await this.service.linkDevice(id, deviceAssetId, user);
  }

  @Delete(':id/devices/:deviceAssetId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('information_asset.manage')
  @ApiOperation({ summary: 'Record that a device no longer holds it' })
  @ApiCommonErrors(401, 403, 404)
  async unlinkDevice(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('deviceAssetId', ParseUUIDPipe) deviceAssetId: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<void> {
    await this.service.unlinkDevice(id, deviceAssetId, user);
  }
}
