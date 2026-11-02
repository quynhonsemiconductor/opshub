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
  Query,
} from '@nestjs/common';
import {
  ApiNoContentResponse,
  ApiOkResponse,
  ApiCreatedResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  Auth,
  RequirePermission,
  ApiCommonErrors,
  ApiPagedResponse,
  CurrentUser,
  buildPageResult,
  RateLimit,
} from '@platform';
import type { JwtPayload, PagedResult } from '@platform';
import { AuditService } from '@modules/audit';
import { EmployeeService } from '../../application/employee.service';
import {
  CreateEmployeeDto,
  ListEmployeesQueryDto,
  UpdateEmployeeDto,
  UpdateStatusDto,
  EmployeeResponseDto,
  PresignAvatarDto,
  ConfirmAvatarDto,
} from './dto/employee.dto';
import type { Employee } from '../../domain/employee.types';

function toDto(e: Employee): EmployeeResponseDto {
  return {
    id: e.id,
    email: e.email,
    displayName: e.displayName,
    department: e.department,
    jobTitle: e.jobTitle,
    managerId: e.managerId,
    groups: e.groupKeys,
    status: e.status,
    photoStorageKey: e.photoStorageKey,
    createdAt: e.createdAt.toISOString(),
  };
}

@ApiTags('employees')
@Controller('employees')
@Auth()
export class EmployeesController {
  constructor(
    private readonly employeeService: EmployeeService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission('employee.read')
  @RateLimit('STRICT')
  @ApiOperation({ summary: 'List employees' })
  @ApiPagedResponse(EmployeeResponseDto)
  @ApiCommonErrors(401)
  async list(@Query() query: ListEmployeesQueryDto): Promise<PagedResult<EmployeeResponseDto>> {
    const { rows, total } = await this.employeeService.list(
      { status: query.status, department: query.department, search: query.search },
      query.limit,
      query.offset,
    );
    return buildPageResult(rows.map(toDto), total, query.limit, query.offset);
  }

  @Get(':id')
  @RequirePermission('employee.read')
  @ApiOperation({ summary: 'Get an employee by id' })
  @ApiOkResponse({ type: EmployeeResponseDto })
  @ApiCommonErrors(401, 404)
  async getById(@Param('id', ParseUUIDPipe) id: string): Promise<EmployeeResponseDto> {
    return toDto(await this.employeeService.getById(id));
  }

  @Post()
  @RequirePermission('employee.write')
  @ApiOperation({ summary: 'Create an employee record' })
  @ApiCreatedResponse({ type: EmployeeResponseDto })
  @ApiCommonErrors(401, 403, 409, 422)
  async create(
    @Body() dto: CreateEmployeeDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<EmployeeResponseDto> {
    const employee = await this.employeeService.create(dto, { sub: user.sub, email: user.email });
    return toDto(employee);
  }

  @Patch(':id')
  @RequirePermission('employee.write')
  @ApiOperation({
    summary: 'Update employee profile fields (display name, department, job title)',
  })
  @ApiOkResponse({ type: EmployeeResponseDto })
  @ApiCommonErrors(401, 403, 404, 422)
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEmployeeDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<EmployeeResponseDto> {
    const employee = await this.employeeService.update(id, dto, {
      sub: user.sub,
      email: user.email,
    });
    return toDto(employee);
  }

  @Patch(':id/status')
  @RequirePermission('employee.write')
  @ApiOperation({
    summary: 'Change employee status — offboarding immediately revokes all active sessions',
  })
  @ApiOkResponse({ type: EmployeeResponseDto })
  @ApiCommonErrors(401, 403, 404, 422)
  async updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStatusDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<EmployeeResponseDto> {
    const employee = await this.employeeService.updateStatus(id, dto.status, {
      sub: user.sub,
      email: user.email,
    });
    return toDto(employee);
  }

  // ── Avatar ──────────────────────────────────────────────────────────────────

  // The scope descriptor matters as much as the permission here. `:id` is the SUBJECT
  // employee, not the caller — `EmployeeService.presignAvatar` loads it only as a 404
  // guard and records the caller as the file's uploader, so without a check any
  // authenticated caller could replace any employee's photo. Naming `employee` as the
  // resource has ResourceScopeResolver load the row and supply `ownerId`, which is what
  // lets a `self`-scoped grant match its holder and a `dept`-scoped one match their
  // department. A global grant passes as before.
  // UPLOAD tier: a presign hands out a signed PUT and a confirm does a HeadObject, so both cost S3
  // requests rather than just database time. Assets carried this from the start; these three surfaces
  // did not, which meant the tier existed and two thirds of the uploads in the product ignored it.
  @RateLimit('UPLOAD')
  @Post(':id/avatar/presign')
  // 200, not Nest's default 201: this is a state transition, not a creation, and `@ApiOkResponse`
  // already promises 200 — without this the generated client's contract disagreed with the server.
  @HttpCode(HttpStatus.OK)
  @RequirePermission('employee.write', { resource: 'employee', from: 'param', field: 'id' })
  @ApiOperation({ summary: 'Get a presigned S3 PUT URL to upload an employee avatar' })
  @ApiOkResponse({
    schema: {
      properties: {
        fileId: { type: 'string' },
        uploadUrl: { type: 'string' },
        key: { type: 'string' },
      },
      required: ['fileId', 'uploadUrl', 'key'],
    },
  })
  @ApiCommonErrors(401, 403, 404, 422)
  async presignAvatar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PresignAvatarDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.employeeService.presignAvatar(id, dto, { sub: user.sub, email: user.email });
  }

  @RateLimit('UPLOAD')
  @Post(':id/avatar/confirm')
  // 200, not Nest's default 201: this is a state transition, not a creation, and `@ApiOkResponse`
  // already promises 200 — without this the generated client's contract disagreed with the server.
  @HttpCode(HttpStatus.OK)
  @RequirePermission('employee.write', { resource: 'employee', from: 'param', field: 'id' })
  @ApiOperation({ summary: 'Confirm avatar upload completed — links the photo to the employee' })
  @ApiOkResponse({
    schema: { properties: { avatarUrl: { type: 'string' } }, required: ['avatarUrl'] },
  })
  @ApiCommonErrors(401, 403, 404, 422)
  async confirmAvatar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmAvatarDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.employeeService.confirmAvatar(id, dto.fileId, { sub: user.sub, email: user.email });
  }

  @Get(':id/avatar')
  @RequirePermission('employee.read', { resource: 'employee', from: 'param', field: 'id' })
  @ApiOperation({ summary: 'Get a time-limited download URL for the employee avatar' })
  @ApiOkResponse({
    schema: {
      properties: { avatarUrl: { type: 'string', nullable: true } },
      required: ['avatarUrl'],
    },
  })
  @ApiCommonErrors(401, 403, 404)
  async getAvatarUrl(@Param('id', ParseUUIDPipe) id: string) {
    return this.employeeService.getAvatarUrl(id);
  }

  @Delete(':id/avatar')
  // Descriptored like the three avatar routes above it, which it was not. `:id` is the SUBJECT
  // employee, so a `dept`-scoped `employee.write` holder could presign and confirm a photo and then
  // be denied when deleting one — the same row, the same permission, a different answer.
  @RequirePermission('employee.write', { resource: 'employee', from: 'param', field: 'id' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete the employee avatar' })
  @ApiNoContentResponse()
  @ApiCommonErrors(401, 403, 404)
  async deleteAvatar(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<void> {
    await this.employeeService.deleteAvatar(id, { sub: user.sub, email: user.email });
  }
}
