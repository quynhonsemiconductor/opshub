import { Module } from '@nestjs/common';
import { AuditModule } from '@modules/audit';
import { EmployeesModule } from '@modules/identity';
import { PositionsService } from './application/positions.service';
import { PositionsController } from './interface/http/positions.controller';
import { PositionsDrizzleRepository } from './infrastructure/persistence/positions.drizzle-repository';
import { POSITIONS_REPOSITORY } from './domain/ports/positions.repository';

@Module({
  // EmployeesModule for EmployeeService: the controller checks an employee exists before
  // assigning, since `employee_id` carries no cross-schema FK.
  imports: [AuditModule, EmployeesModule],
  controllers: [PositionsController],
  providers: [
    PositionsService,
    { provide: POSITIONS_REPOSITORY, useClass: PositionsDrizzleRepository },
  ],
  exports: [PositionsService],
})
export class PositionsModule {}
