import { Module } from '@nestjs/common';
import { AuditModule } from '@modules/audit';
import { EmployeesModule } from '@modules/identity';
import { RolesService } from './application/roles.service';
import { JobRanksService } from './application/job-ranks.service';
import { JobRanksController } from './interface/http/job-ranks.controller';
import { JobRanksDrizzleRepository } from './infrastructure/persistence/job-ranks.drizzle-repository';
import { JOB_RANKS_REPOSITORY } from './domain/ports/job-ranks.repository';
import { RolesController } from './interface/http/roles.controller';
import { RolesDrizzleRepository } from './infrastructure/persistence/roles.drizzle-repository';
import { ROLES_REPOSITORY } from './domain/ports/roles.repository';

@Module({
  // EmployeesModule for EmployeeService: the controller checks an employee exists before
  // assigning, since `employee_id` carries no cross-schema FK.
  imports: [AuditModule, EmployeesModule],
  controllers: [RolesController, JobRanksController],
  providers: [
    RolesService,
    JobRanksService,
    { provide: ROLES_REPOSITORY, useClass: RolesDrizzleRepository },
    { provide: JOB_RANKS_REPOSITORY, useClass: JobRanksDrizzleRepository },
  ],
  exports: [RolesService, JobRanksService],
})
export class RolesModule {}
