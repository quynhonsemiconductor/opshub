import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiCommonErrors,
  ApiPagedResponse,
  Auth,
  CurrentUser,
  RequirePermission,
  SelfScoped,
  buildPageResult,
  type JwtPayload,
  type PagedResult,
} from '@platform';
import { EmployeeService } from '@modules/identity';
import { RolesService } from '../../application/roles.service';
import type {
  EmployeeRole,
  EmployeeRoleWithDetails,
  Role,
  RoleOccupancy,
} from '../../domain/roles.types';
import {
  AssignRoleDto,
  CreateRoleDto,
  EmployeeRoleHistoryResponseDto,
  EmployeeRoleResponseDto,
  RoleAssignmentResponseDto,
  EndAssignmentDto,
  ListRolesQueryDto,
  RoleOccupancyResponseDto,
  RoleResponseDto,
  UpdateRoleDto,
} from './dto/roles.dto';

function toRoleDto(p: Role): RoleResponseDto {
  return {
    id: p.id,
    code: p.code,
    title: p.title,
    department: p.department,
    rankId: p.rankId,
    headcount: p.headcount,
    description: p.description,
    status: p.status,
    createdAt: p.createdAt.toISOString(),
  };
}

function toOccupancyDto(p: RoleOccupancy): RoleOccupancyResponseDto {
  return { ...toRoleDto(p), filled: p.filled, vacancies: p.vacancies };
}

/** The named read shape. `toAssignmentDto` stays for the writes, which have no name to give. */
function toNamedAssignmentDto(
  a: EmployeeRole & { employeeName: string | null },
): RoleAssignmentResponseDto {
  return { ...toAssignmentDto(a), employeeName: a.employeeName };
}

function toAssignmentDto(a: EmployeeRole): EmployeeRoleResponseDto {
  return {
    id: a.id,
    employeeId: a.employeeId,
    roleId: a.roleId,
    effectiveFrom: a.effectiveFrom,
    effectiveTo: a.effectiveTo,
    endReason: a.endReason,
    createdAt: a.createdAt.toISOString(),
  };
}

/** The history shape — the same row, plus the role it refers to. */
function toHistoryDto(a: EmployeeRoleWithDetails): EmployeeRoleHistoryResponseDto {
  return { ...toAssignmentDto(a), roleCode: a.roleCode, roleTitle: a.roleTitle };
}

@ApiTags('roles')
@Controller('roles')
@Auth()
export class RolesController {
  constructor(
    private readonly service: RolesService,
    private readonly employees: EmployeeService,
  ) {}

  /**
   * The role the CALLER holds, and their history.
   *
   * Self-scoped and first because it is the only route here most employees need. Knowing your own
   * role and when it changed is not privileged information about anyone else.
   */
  @Get('me')
  @SelfScoped("returns the caller's own role history — keyed on their own id")
  @ApiOperation({ summary: 'My role history, newest first' })
  @ApiOkResponse({ type: [EmployeeRoleHistoryResponseDto] })
  @ApiCommonErrors(401)
  async myRoles(@CurrentUser() user: JwtPayload): Promise<EmployeeRoleHistoryResponseDto[]> {
    return (await this.service.listAssignmentsForEmployee(user.sub)).map(toHistoryDto);
  }

  @Get()
  @RequirePermission('role.read')
  @ApiOperation({
    summary: 'List roles with occupancy',
    description:
      'Each row carries `filled` (open assignments) and `vacancies` (`headcount - filled`, ' +
      'floored at 0). `vacantOnly` narrows to roles with an unfilled approved slot.',
  })
  @ApiPagedResponse(RoleOccupancyResponseDto)
  @ApiCommonErrors(401, 403)
  async list(@Query() query: ListRolesQueryDto): Promise<PagedResult<RoleOccupancyResponseDto>> {
    const { rows, total } = await this.service.listRoles(
      {
        search: query.search,
        department: query.department,
        status: query.status,
        vacantOnly: query.vacantOnly,
      },
      query.limit,
      query.offset,
    );
    return buildPageResult(rows.map(toOccupancyDto), total, query.limit, query.offset);
  }

  @Get(':id')
  @RequirePermission('role.read')
  @ApiOperation({ summary: 'Get a role' })
  @ApiOkResponse({ type: RoleResponseDto })
  @ApiCommonErrors(401, 403, 404)
  async getById(@Param('id', ParseUUIDPipe) id: string): Promise<RoleResponseDto> {
    return toRoleDto(await this.service.getRole(id));
  }

  @Get(':id/assignments')
  @RequirePermission('role.read')
  @ApiOperation({
    summary: 'Everyone who has held this role, newest first',
    description: 'History, not just current occupants — closed assignments are never deleted.',
  })
  @ApiOkResponse({ type: [RoleAssignmentResponseDto] })
  @ApiCommonErrors(401, 403, 404)
  async listAssignments(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<RoleAssignmentResponseDto[]> {
    return (await this.service.listAssignmentsForRole(id)).map(toNamedAssignmentDto);
  }

  @Post()
  @RequirePermission('role.manage')
  @ApiOperation({ summary: 'Define a role' })
  @ApiCreatedResponse({ type: RoleResponseDto })
  @ApiCommonErrors(401, 403, 409, 422)
  async create(
    @Body() dto: CreateRoleDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<RoleResponseDto> {
    return toRoleDto(await this.service.createRole(dto, user));
  }

  @Patch(':id')
  @RequirePermission('role.manage')
  @ApiOperation({
    summary: 'Change a role, including approved headcount',
    description:
      'Reducing headcount below current occupancy is ALLOWED — a restructure is a real event — ' +
      'and shows as `vacancies: 0` with `filled > headcount`. No new assignment can be made ' +
      'until that resolves.',
  })
  @ApiOkResponse({ type: RoleResponseDto })
  @ApiCommonErrors(401, 403, 404, 422)
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRoleDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<RoleResponseDto> {
    return toRoleDto(await this.service.updateRole(id, dto, user));
  }

  @Post(':id/assignments')
  @RequirePermission('role.manage')
  @ApiOperation({
    summary: 'Assign an employee, transferring them if they hold another role',
    description:
      'One transaction: closes any current assignment, checks approved headcount, opens the new ' +
      'one. A frozen or closed role accepts nobody new.',
  })
  @ApiCreatedResponse({ type: EmployeeRoleResponseDto })
  @ApiCommonErrors(401, 403, 404, 409, 412, 422)
  async assign(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignRoleDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<EmployeeRoleResponseDto> {
    // `employee_id` carries no cross-schema FK, matching every other module, so a typo would
    // otherwise become an assignment for somebody who does not exist.
    await this.employees.assertExist(dto.employeeId);
    return toAssignmentDto(
      await this.service.assign(
        {
          employeeId: dto.employeeId,
          roleId: id,
          effectiveFrom: dto.effectiveFrom,
          endReason: dto.endReason,
        },
        user,
      ),
    );
  }

  @Patch('assignments/:id/end')
  @RequirePermission('role.manage')
  @ApiOperation({
    summary: 'End an assignment without opening another',
    description:
      'A departure or a vacated role. The row is closed, never deleted. An `effectiveTo` before ' +
      'the assignment started is refused with `ROLE_INVALID_WINDOW`.',
  })
  @ApiOkResponse({ type: EmployeeRoleResponseDto })
  @ApiCommonErrors(401, 403, 404, 412, 422)
  async endAssignment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EndAssignmentDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<EmployeeRoleResponseDto> {
    return toAssignmentDto(await this.service.endAssignment(id, dto, user));
  }

  @Get('employees/:employeeId/history')
  @RequirePermission('role.read')
  @ApiOperation({ summary: "One employee's role history, newest first" })
  @ApiOkResponse({ type: [EmployeeRoleHistoryResponseDto] })
  @ApiCommonErrors(401, 403, 404)
  async employeeHistory(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
  ): Promise<EmployeeRoleHistoryResponseDto[]> {
    await this.employees.assertExist(employeeId);
    return (await this.service.listAssignmentsForEmployee(employeeId)).map(toHistoryDto);
  }
}
