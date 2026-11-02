import { Module } from '@nestjs/common';
import { AuditModule } from '@modules/audit';
import { EmployeesModule } from '@modules/identity';
import { PositionsService } from './application/positions.service';
import { JobRanksService } from './application/job-ranks.service';
import { JobRanksController } from './interface/http/job-ranks.controller';
import { JobRanksDrizzleRepository } from './infrastructure/persistence/job-ranks.drizzle-repository';
import { JOB_RANKS_REPOSITORY } from './domain/ports/job-ranks.repository';
import { PositionsController } from './interface/http/positions.controller';
import { PositionsDrizzleRepository } from './infrastructure/persistence/positions.drizzle-repository';
import { POSITIONS_REPOSITORY } from './domain/ports/positions.repository';

@Module({
  // EmployeesModule for EmployeeService: the controller checks an employee exists before
  // assigning, since `employee_id` carries no cross-schema FK.
  imports: [AuditModule, EmployeesModule],
  controllers: [PositionsController, JobRanksController],
  providers: [
    PositionsService,
    JobRanksService,
    { provide: POSITIONS_REPOSITORY, useClass: PositionsDrizzleRepository },
    { provide: JOB_RANKS_REPOSITORY, useClass: JobRanksDrizzleRepository },
  ],
  exports: [PositionsService, JobRanksService],
})
export class PositionsModule {}
