import { Module } from '@nestjs/common';
import { AuditModule } from '@modules/audit';
import { GraphTasksModule } from '@modules/graph';
import { EmployeesModule } from '@modules/identity';
import { LeaveBalanceService } from './application/leave-balance.service';
import { WorkforceService } from './application/workforce.service';
import { WioCalendarService } from './application/wio-calendar.service';
import { LeaveRequestTypeDef } from './application/leave-request.type-def';
import { WfhRequestTypeDef } from './application/wfh-request.type-def';
import { OvertimeTypeDef } from './application/overtime.type-def';
import { OnboardingTypeDef } from './application/onboarding.type-def';
import { OffboardingTypeDef } from './application/offboarding.type-def';
import { WorkforceController } from './interface/http/workforce.controller';
import { WioCalendarController } from './interface/http/wio-calendar.controller';
import { WorkforceDrizzleRepository } from './infrastructure/persistence/workforce.drizzle-repository';
import { WORKFORCE_REPOSITORY } from './domain/ports/workforce.repository';

@Module({
  imports: [AuditModule, EmployeesModule, GraphTasksModule],
  controllers: [WorkforceController, WioCalendarController],
  providers: [
    WorkforceService,
    WioCalendarService,
    LeaveBalanceService,
    LeaveRequestTypeDef,
    WfhRequestTypeDef,
    OvertimeTypeDef,
    OnboardingTypeDef,
    OffboardingTypeDef,
    { provide: WORKFORCE_REPOSITORY, useClass: WorkforceDrizzleRepository },
  ],
  exports: [WorkforceService, LeaveBalanceService],
})
export class WorkforceModule {}
