import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ApiCommonErrors, Auth, CurrentUser, RequirePermission, SelfScoped } from '@platform';
import type {
  EmployeePermission,
  JwtPayload,
  Permission,
  EmployeeGroup,
  GroupWithPermissions,
} from '@platform';
import { DelegationService, type ApprovalDelegation } from '@platform';
import { AuditService, AUDIT_ACTION, AUDIT_RESOURCE } from '@modules/audit';
import { AuthzAdminService } from '../../application/authz-admin.service';
import {
  AssignGroupDto,
  CreateDelegationDto,
  CreateGroupDto,
  DelegationResponseDto,
  EmployeePermissionResponseDto,
  GrantEmployeePermissionDto,
  ListDelegationsQueryDto,
  PermissionResponseDto,
  EmployeeGroupResponseDto,
  GroupResponseDto,
  SetGroupPermissionsDto,
} from './dto/authz.dto';

function toGroupDto(r: GroupWithPermissions): GroupResponseDto {
  return {
    id: r.id,
    key: r.key,
    name: r.name,
    system: r.system,
    permissions: r.permissions,
    updatedAt: r.updatedAt.toISOString(),
  };
}

function toEmployeeGroupDto(a: EmployeeGroup): EmployeeGroupResponseDto {
  return {
    id: a.id,
    employeeId: a.employeeId,
    groupId: a.groupId,
    scopeType: a.scopeType,
    scopeId: a.scopeId,
    grantedBy: a.grantedBy,
    expiresAt: a.expiresAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
  };
}

function toEmployeePermissionDto(g: EmployeePermission): EmployeePermissionResponseDto {
  return {
    id: g.id,
    employeeId: g.employeeId,
    permissionKey: g.permissionKey,
    scopeType: g.scopeType,
    scopeId: g.scopeId,
    grantedBy: g.grantedBy,
    reason: g.reason,
    expiresAt: g.expiresAt?.toISOString() ?? null,
    createdAt: g.createdAt.toISOString(),
  };
}

function toDelegationDto(d: ApprovalDelegation): DelegationResponseDto {
  return {
    id: d.id,
    fromUserId: d.fromUserId,
    toUserId: d.toUserId,
    startsAt: d.startsAt.toISOString(),
    endsAt: d.endsAt.toISOString(),
    reason: d.reason,
    createdAt: d.createdAt.toISOString(),
  };
}

@ApiTags('authz')
@Controller('authz')
export class AuthzController {
  constructor(
    private readonly authz: AuthzAdminService,
    private readonly delegation: DelegationService,
    private readonly audit: AuditService,
  ) {}

  @Get('permissions')
  @RequirePermission('rbac.read')
  @ApiOperation({ summary: 'List the permission catalog' })
  @ApiOkResponse({ type: [PermissionResponseDto] })
  @ApiCommonErrors(401, 403)
  async listPermissions(): Promise<PermissionResponseDto[]> {
    return (await this.authz.listPermissions()) satisfies Permission[];
  }

  @Get('groups')
  @RequirePermission('rbac.read')
  @ApiOperation({ summary: 'List groups with their permissions' })
  @ApiOkResponse({ type: [GroupResponseDto] })
  @ApiCommonErrors(401, 403)
  async listGroups(): Promise<GroupResponseDto[]> {
    return (await this.authz.listGroups()).map(toGroupDto);
  }

  @Get('groups/:id')
  @RequirePermission('rbac.read')
  @ApiOperation({ summary: 'Get a group by id' })
  @ApiOkResponse({ type: GroupResponseDto })
  @ApiCommonErrors(401, 403, 404)
  async getGroup(@Param('id', ParseUUIDPipe) id: string): Promise<GroupResponseDto> {
    return toGroupDto(await this.authz.getGroup(id));
  }

  @Post('groups')
  @RequirePermission('rbac.manage')
  @ApiOperation({ summary: 'Create a custom group' })
  @ApiCreatedResponse({ type: GroupResponseDto })
  @ApiCommonErrors(401, 403, 409, 422)
  async createGroup(
    @Body() dto: CreateGroupDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<GroupResponseDto> {
    const group = await this.authz.createGroup(dto, { sub: user.sub, email: user.email });
    return toGroupDto(group);
  }

  @Put('groups/:id/permissions')
  @RequirePermission('rbac.manage')
  @ApiOperation({ summary: 'Replace a group’s permission set' })
  @ApiOkResponse({ type: GroupResponseDto })
  @ApiCommonErrors(401, 403, 404, 422)
  async setGroupPermissions(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetGroupPermissionsDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<GroupResponseDto> {
    const group = await this.authz.setGroupPermissions(id, dto.permissions, {
      sub: user.sub,
      email: user.email,
    });
    return toGroupDto(group);
  }

  @Delete('groups/:id')
  @HttpCode(204)
  @RequirePermission('rbac.manage')
  @ApiOperation({ summary: 'Delete a custom (non-system) group' })
  @ApiNoContentResponse()
  @ApiCommonErrors(401, 403, 404, 422)
  async deleteGroup(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<void> {
    await this.authz.deleteGroup(id, { sub: user.sub, email: user.email });
  }

  @Get('employees/:employeeId/groups')
  @RequirePermission('rbac.read')
  @ApiOperation({ summary: 'List the groups an employee belongs to' })
  @ApiOkResponse({ type: [EmployeeGroupResponseDto] })
  @ApiCommonErrors(401, 403)
  async listEmployeeGroups(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
  ): Promise<EmployeeGroupResponseDto[]> {
    return (await this.authz.listEmployeeGroups(employeeId)).map(toEmployeeGroupDto);
  }

  @Post('employee-groups')
  @RequirePermission('role.assign')
  @ApiOperation({ summary: 'Put an employee in a group, optionally scoped' })
  @ApiCreatedResponse({ type: EmployeeGroupResponseDto })
  @ApiCommonErrors(401, 403, 404, 422)
  async assignGroup(
    @Body() dto: AssignGroupDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<EmployeeGroupResponseDto> {
    const assignment = await this.authz.assignGroup(
      {
        employeeId: dto.employeeId,
        groupId: dto.groupId,
        scopeType: dto.scopeType,
        scopeId: dto.scopeId ?? null,
        expiresAt: dto.expiresAt ?? null,
      },
      { sub: user.sub, email: user.email },
    );
    return toEmployeeGroupDto(assignment);
  }

  @Delete('employee-groups/:id')
  @HttpCode(204)
  @RequirePermission('role.assign')
  @ApiOperation({ summary: 'Remove an employee from a group' })
  @ApiNoContentResponse()
  @ApiCommonErrors(401, 403, 404)
  async revokeEmployeeGroup(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<void> {
    await this.authz.revokeEmployeeGroup(id, { sub: user.sub, email: user.email });
  }

  // ── Direct employee permissions ────────────────────────────────────────────

  @Get('employees/:employeeId/permissions')
  @RequirePermission('rbac.read')
  @ApiOperation({ summary: 'List the permissions granted straight to an employee' })
  @ApiOkResponse({ type: [EmployeePermissionResponseDto] })
  @ApiCommonErrors(401, 403)
  async listEmployeePermissions(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
  ): Promise<EmployeePermissionResponseDto[]> {
    return (await this.authz.listEmployeePermissions(employeeId)).map(toEmployeePermissionDto);
  }

  @Post('employee-permissions')
  @RequirePermission('role.assign')
  @ApiOperation({
    summary: 'Grant one permission straight to an employee',
    description:
      'The exception path, outside any group: a `reason` is required, and the caller must hold the ' +
      'permission globally themselves (no privilege escalation).',
  })
  @ApiCreatedResponse({ type: EmployeePermissionResponseDto })
  @ApiCommonErrors(401, 403, 404, 422)
  async grantEmployeePermission(
    @Body() dto: GrantEmployeePermissionDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<EmployeePermissionResponseDto> {
    const grant = await this.authz.grantEmployeePermission(
      {
        employeeId: dto.employeeId,
        permissionKey: dto.permissionKey,
        scopeType: dto.scopeType,
        scopeId: dto.scopeId ?? null,
        reason: dto.reason,
        expiresAt: dto.expiresAt ?? null,
      },
      { sub: user.sub, email: user.email },
    );
    return toEmployeePermissionDto(grant);
  }

  @Delete('employee-permissions/:id')
  @HttpCode(204)
  @RequirePermission('role.assign')
  @ApiOperation({ summary: 'Revoke a permission granted straight to an employee' })
  @ApiNoContentResponse()
  @ApiCommonErrors(401, 403, 404)
  async revokeEmployeePermission(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<void> {
    await this.authz.revokeEmployeePermission(id, { sub: user.sub, email: user.email });
  }

  // ── Approval Delegation ────────────────────────────────────────────────────

  @Post('delegations')
  @SelfScoped("delegates the CALLER's own approval authority — fromUserId is user.sub")
  @ApiOperation({
    summary: 'Create an approval delegation',
    description:
      'Delegates your approval authority to another user for a specified time window. ' +
      'Useful for out-of-office coverage.',
  })
  @ApiCreatedResponse({ type: DelegationResponseDto })
  @ApiCommonErrors(401, 422)
  async createDelegation(
    @Body() dto: CreateDelegationDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<DelegationResponseDto> {
    const d = await this.delegation.create({
      fromUserId: user.sub,
      toUserId: dto.toUserId,
      startsAt: dto.startsAt,
      endsAt: dto.endsAt,
      reason: dto.reason,
    });
    void this.audit.record({
      actorId: user.sub,
      actorEmail: user.email,
      action: AUDIT_ACTION.DELEGATION_CREATED,
      resourceType: AUDIT_RESOURCE.DELEGATION,
      resourceId: d.id,
      metadata: { toUserId: dto.toUserId, startsAt: dto.startsAt, endsAt: dto.endsAt },
    });
    return toDelegationDto(d);
  }

  @Get('delegations')
  @SelfScoped('lists delegations the caller granted or received')
  @ApiOperation({
    summary: 'List approval delegations',
    description:
      'Use `?direction=from` (default) to list delegations you created; ' +
      '`?direction=to` for delegations you received.',
  })
  @ApiOkResponse({ type: [DelegationResponseDto] })
  @ApiCommonErrors(401)
  async listDelegations(
    @Query() query: ListDelegationsQueryDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<DelegationResponseDto[]> {
    const rows =
      query.direction === 'to'
        ? await this.delegation.listTo(user.sub)
        : await this.delegation.listFrom(user.sub);
    return rows.map(toDelegationDto);
  }

  @Delete('delegations/:id')
  @SelfScoped('revoke is keyed on (id, user.sub), so only the grantor can revoke')
  @Auth()
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke an approval delegation' })
  @ApiNoContentResponse()
  @ApiCommonErrors(401, 403, 404)
  async revokeDelegation(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<void> {
    await this.delegation.revoke(id, user.sub);
    void this.audit.record({
      actorId: user.sub,
      actorEmail: user.email,
      action: AUDIT_ACTION.DELEGATION_REVOKED,
      resourceType: AUDIT_RESOURCE.DELEGATION,
      resourceId: id,
    });
  }
}
