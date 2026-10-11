import { Module } from '@nestjs/common';
import { AuditModule } from '@modules/audit';
import { EmployeeService } from './application/employee.service';
import { EMPLOYEE_REPOSITORY } from './domain/ports/employee.repository';
import { EmployeeDrizzleRepository } from './infrastructure/persistence/employee.drizzle-repository';
import { UserDirectory } from './infrastructure/auth/user-directory';
import { EmployeesController } from './interface/http/employees.controller';

/**
 * The employee directory: `EmployeeService` and its repository, WITHOUT authentication.
 *
 * Split from `AuthModule` because the WORKER compiles this too (contracts and training import
 * `EmployeeService`), and the worker must not load identity 8's Fastify mount or its global session guard.
 * `SessionRevoker`, which `EmployeeService` needs only to change a status, is bound by the API's `AuthModule`
 * (global) and is optional here.
 */
@Module({
  imports: [AuditModule],
  controllers: [EmployeesController],
  providers: [
    EmployeeService,
    UserDirectory,
    { provide: EMPLOYEE_REPOSITORY, useClass: EmployeeDrizzleRepository },
  ],
  exports: [EmployeeService, UserDirectory],
})
export class EmployeesModule {}
