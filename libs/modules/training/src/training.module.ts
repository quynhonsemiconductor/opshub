import { Module } from '@nestjs/common';
import { AuditModule } from '@modules/audit';
import { EmployeesModule } from '@modules/identity';
import { TrainingService } from './application/training.service';
import { TrainingController } from './interface/http/training.controller';
import { TrainingDrizzleRepository } from './infrastructure/persistence/training.drizzle-repository';
import { TRAINING_REPOSITORY } from './domain/ports/training.repository';

@Module({
  // EmployeesModule for EmployeeService: the controller checks an employee exists before recording a
  // completion for them, since `employee_id` carries no cross-schema FK. `EntityAttachmentsService`
  // needs no import — PlatformModule is global.
  imports: [AuditModule, EmployeesModule],
  controllers: [TrainingController],
  providers: [
    TrainingService,
    { provide: TRAINING_REPOSITORY, useClass: TrainingDrizzleRepository },
  ],
  exports: [TrainingService],
})
export class TrainingModule {}
