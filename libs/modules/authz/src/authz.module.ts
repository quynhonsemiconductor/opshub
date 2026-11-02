import { Module } from '@nestjs/common';
import { AuditModule } from '@modules/audit';
import { AuthzController } from './interface/http/authz.controller';
import { AuthzAdminService } from './application/authz-admin.service';
import { GroupDrizzleRepository } from './infrastructure/persistence/group.drizzle-repository';
import { EmployeeGroupDrizzleRepository } from './infrastructure/persistence/employee-group.drizzle-repository';
import { GROUP_REPOSITORY } from './domain/ports/group.repository';
import { EMPLOYEE_GROUP_REPOSITORY } from './domain/ports/employee-group.repository';
import { EmployeePermissionDrizzleRepository } from './infrastructure/persistence/employee-permission.drizzle-repository';
import { EMPLOYEE_PERMISSION_REPOSITORY } from './domain/ports/employee-permission.repository';

/**
 * Authz module — administrative RBAC surface (manage groups/permissions, grant
 * and remove scoped group memberships, grant direct permissions). Enforcement (PolicyGuard, AuthzService)
 * lives in the global PlatformModule; this module manages the data it reads.
 */
@Module({
  imports: [AuditModule],
  controllers: [AuthzController],
  providers: [
    AuthzAdminService,
    { provide: GROUP_REPOSITORY, useClass: GroupDrizzleRepository },
    { provide: EMPLOYEE_GROUP_REPOSITORY, useClass: EmployeeGroupDrizzleRepository },
    { provide: EMPLOYEE_PERMISSION_REPOSITORY, useClass: EmployeePermissionDrizzleRepository },
  ],
  exports: [AuthzAdminService],
})
export class AuthzModule {}
