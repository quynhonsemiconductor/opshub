import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  RequirePermission,
  ApiCommonErrors,
  ApiPagedResponse,
  buildPageResult,
  CurrentUser,
  RateLimit,
} from '@platform';
import type { JwtPayload, PagedResult } from '@platform';
import { LicenseService } from '../../application/license.service';
import type {
  SoftwareLicense,
  LicenseAssignment,
  LicenseUtilization,
} from '../../domain/license.types';
import {
  CreateLicenseDto,
  UpdateLicenseDto,
  ListLicensesQueryDto,
  AssignSeatDto,
  ListAssignmentsQueryDto,
  LicenseResponseDto,
  LicenseAssignmentResponseDto,
  LicenseUtilizationDto,
} from './dto/license.dto';

function toLicenseDto(l: SoftwareLicense): LicenseResponseDto {
  return {
    id: l.id,
    name: l.name,
    vendor: l.vendor,
    vendorId: l.vendorId,
    licenseType: l.licenseType,
    seatCount: l.seatCount,
    costPerSeatCents: l.costPerSeatCents,
    renewalDate: l.renewalDate,
    status: l.status,
    notes: l.notes,
    externalId: l.externalId,
    createdAt: l.createdAt.toISOString(),
    updatedAt: l.updatedAt.toISOString(),
  };
}

function toAssignmentDto(
  a: LicenseAssignment & { employeeName?: string | null },
): LicenseAssignmentResponseDto {
  return {
    id: a.id,
    licenseId: a.licenseId,
    employeeId: a.employeeId,
    // Resolved on the list read, absent on the assign write — one DTO, and the field is nullable
    // rather than the shape being forked over a single value.
    employeeName: a.employeeName ?? null,
    assignedAt: a.assignedAt.toISOString(),
    revokedAt: a.revokedAt ? a.revokedAt.toISOString() : null,
    notes: a.notes,
  };
}

function toUtilDto(u: LicenseUtilization): LicenseUtilizationDto {
  return {
    licenseId: u.licenseId,
    name: u.name,
    vendor: u.vendor,
    seatCount: u.seatCount,
    usedSeats: u.usedSeats,
    availableSeats: u.availableSeats,
    utilizationPct: u.utilizationPct,
    monthlySpendCents: u.monthlySpendCents,
  };
}

@ApiTags('licenses')
@Controller('licenses')
export class LicensesController {
  constructor(private readonly licenseService: LicenseService) {}

  @Get()
  @RequirePermission('license.read')
  @RateLimit('STRICT')
  @ApiOperation({ summary: 'List software licenses' })
  @ApiPagedResponse(LicenseResponseDto)
  @ApiCommonErrors(401, 403)
  async list(@Query() query: ListLicensesQueryDto): Promise<PagedResult<LicenseResponseDto>> {
    const { rows, total } = await this.licenseService.list(
      { status: query.status, vendor: query.vendor, search: query.search },
      query.limit,
      query.offset,
    );
    return buildPageResult(rows.map(toLicenseDto), total, query.limit, query.offset);
  }

  @Post()
  @RequirePermission('license.manage')
  @RateLimit('STRICT')
  @ApiOperation({ summary: 'Create a software license record' })
  @ApiCreatedResponse({ type: LicenseResponseDto })
  @ApiCommonErrors(400, 401, 403)
  async create(
    @Body() dto: CreateLicenseDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<LicenseResponseDto> {
    return toLicenseDto(
      await this.licenseService.create(
        {
          name: dto.name,
          vendor: dto.vendor,
          vendorId: dto.vendorId,
          licenseType: dto.licenseType,
          seatCount: dto.seatCount,
          costPerSeatCents: dto.costPerSeatCents,
          renewalDate: dto.renewalDate,
          notes: dto.notes,
          externalId: dto.externalId,
        },
        { sub: user.sub, email: user.email },
      ),
    );
  }

  @Get('utilization')
  @RequirePermission('license.read')
  @ApiOperation({ summary: 'Seat utilization and monthly spend across all licenses' })
  @ApiOkResponse({ type: LicenseUtilizationDto, isArray: true })
  @ApiCommonErrors(401, 403)
  async getUtilization(): Promise<LicenseUtilizationDto[]> {
    return (await this.licenseService.getUtilization()).map(toUtilDto);
  }

  @Get(':id')
  @RequirePermission('license.read')
  @ApiOperation({ summary: 'Get a license by id' })
  @ApiOkResponse({ type: LicenseResponseDto })
  @ApiCommonErrors(401, 403, 404)
  async getById(@Param('id', ParseUUIDPipe) id: string): Promise<LicenseResponseDto> {
    return toLicenseDto(await this.licenseService.getById(id));
  }

  @Patch(':id')
  @RequirePermission('license.manage')
  @ApiOperation({ summary: 'Update a license record' })
  @ApiOkResponse({ type: LicenseResponseDto })
  @ApiCommonErrors(400, 401, 403, 404)
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLicenseDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<LicenseResponseDto> {
    return toLicenseDto(
      await this.licenseService.update(id, dto, { sub: user.sub, email: user.email }),
    );
  }

  @Delete(':id')
  @RequirePermission('license.manage')
  @ApiOperation({ summary: 'Delete a license (no active seats allowed)' })
  @ApiNoContentResponse()
  @ApiCommonErrors(401, 403, 404, 409)
  async delete(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<void> {
    await this.licenseService.delete(id, { sub: user.sub, email: user.email });
  }

  @Get(':id/assignments')
  @RequirePermission('license.read')
  @ApiOperation({ summary: 'List seat assignments for a license' })
  @ApiOkResponse({ type: LicenseAssignmentResponseDto, isArray: true })
  @ApiCommonErrors(401, 403, 404)
  async listAssignments(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListAssignmentsQueryDto,
  ): Promise<LicenseAssignmentResponseDto[]> {
    return (await this.licenseService.listAssignments(id, query.includeRevoked)).map(
      toAssignmentDto,
    );
  }

  @Post(':id/assignments')
  @RequirePermission('license.manage')
  @ApiOperation({ summary: 'Assign a seat to an employee' })
  @ApiCreatedResponse({ type: LicenseAssignmentResponseDto })
  @ApiCommonErrors(400, 401, 403, 404, 409)
  async assign(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignSeatDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<LicenseAssignmentResponseDto> {
    return toAssignmentDto(
      await this.licenseService.assign(id, dto.employeeId, dto.notes ?? null, {
        sub: user.sub,
        email: user.email,
      }),
    );
  }

  @Delete('assignments/:assignmentId')
  @RequirePermission('license.manage')
  @ApiOperation({ summary: 'Revoke a seat assignment' })
  @ApiNoContentResponse()
  @ApiCommonErrors(401, 403, 404)
  async revoke(
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<void> {
    await this.licenseService.revoke(assignmentId, { sub: user.sub, email: user.email });
  }
}
