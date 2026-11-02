import { Module } from '@nestjs/common';
import { AuditModule } from '@modules/audit';
import { AuthzController } from './interface/http/authz.controller';
import { AuthzAdminService } from './application/authz-admin.service';
import { RoleDrizzleRepository } from './infrastructure/persistence/role.drizzle-repository';
import { RoleAssignmentDrizzleRepository } from './infrastructure/persistence/role-assignment.drizzle-repository';
import { ROLE_REPOSITORY } from './domain/ports/role.repository';
import { ROLE_ASSIGNMENT_REPOSITORY } from './domain/ports/role-assignment.repository';
import { EmployeePermissionDrizzleRepository } from './infrastructure/persistence/employee-permission.drizzle-repository';
import { EMPLOYEE_PERMISSION_REPOSITORY } from './domain/ports/employee-permission.repository';

/**
 * Authz module — administrative RBAC surface (manage roles/permissions, grant
 * and revoke scoped role assignments). Enforcement (PolicyGuard, AuthzService)
 * lives in the global PlatformModule; this module manages the data it reads.
 */
@Module({
  imports: [AuditModule],
  controllers: [AuthzController],
  providers: [
    AuthzAdminService,
    { provide: ROLE_REPOSITORY, useClass: RoleDrizzleRepository },
    { provide: ROLE_ASSIGNMENT_REPOSITORY, useClass: RoleAssignmentDrizzleRepository },
    { provide: EMPLOYEE_PERMISSION_REPOSITORY, useClass: EmployeePermissionDrizzleRepository },
  ],
  exports: [AuthzAdminService],
})
export class AuthzModule {}
