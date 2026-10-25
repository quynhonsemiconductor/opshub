import { Module } from '@nestjs/common';
import { AuditModule } from '@modules/audit';
import { EmployeesModule } from '@modules/identity';
import { PositionsModule } from '@modules/positions';
import { PerformanceService } from './application/performance.service';
import { PerformanceReviewTypeDef } from './application/performance-review.type-def';
import { PerformanceController } from './interface/http/performance.controller';
import { PerformanceDrizzleRepository } from './infrastructure/persistence/performance.drizzle-repository';
import { PERFORMANCE_REPOSITORY } from './domain/ports/performance.repository';

@Module({
  // EmployeesModule for EmployeeService: the controller proves both the subject and the reviewer
  // exist before creating a review, since neither id carries a cross-schema FK. PositionsModule for
  // the CURRENT assignment, which is frozen onto the review at creation. `RequestEngine` and
  // `RequestRegistry` need no import — PlatformModule is global.
  imports: [AuditModule, EmployeesModule, PositionsModule],
  controllers: [PerformanceController],
  providers: [
    PerformanceService,
    PerformanceReviewTypeDef,
    { provide: PERFORMANCE_REPOSITORY, useClass: PerformanceDrizzleRepository },
  ],
  exports: [PerformanceService],
})
export class PerformanceModule {}
