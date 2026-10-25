import { Module } from '@nestjs/common';
import { AuditModule } from '@modules/audit';
import { EmployeesModule } from '@modules/identity';
import { DocumentsService } from './application/documents.service';
import { DocumentApprovalTypeDef } from './application/document-approval.type-def';
import { DocumentsController } from './interface/http/documents.controller';
import { DocumentsDrizzleRepository } from './infrastructure/persistence/documents.drizzle-repository';
import { DOCUMENTS_REPOSITORY } from './domain/ports/documents.repository';

@Module({
  // EmployeesModule for EmployeeService: the controller checks the owner exists, since
  // `owner_id` carries no cross-schema FK.
  imports: [AuditModule, EmployeesModule],
  controllers: [DocumentsController],
  providers: [
    DocumentsService,
    DocumentApprovalTypeDef,
    { provide: DOCUMENTS_REPOSITORY, useClass: DocumentsDrizzleRepository },
  ],
  exports: [DocumentsService],
})
export class DocumentsModule {}
