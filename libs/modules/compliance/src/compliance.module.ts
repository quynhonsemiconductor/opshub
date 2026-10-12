import { Module } from '@nestjs/common';
import { AuditModule } from '@modules/audit';
import { GraphTasksModule } from '@modules/graph';
import { ComplianceService } from './application/compliance.service';
import { ShadowItFindingsService } from './application/shadow-it-findings.service';
import { ComplianceController } from './interface/http/compliance.controller';
import { ComplianceDrizzleRepository } from './infrastructure/persistence/compliance.drizzle-repository';
import { COMPLIANCE_REPOSITORY } from './domain/ports/compliance.repository';

@Module({
  imports: [AuditModule, GraphTasksModule],
  controllers: [ComplianceController],
  providers: [
    ComplianceService,
    ShadowItFindingsService,
    { provide: COMPLIANCE_REPOSITORY, useClass: ComplianceDrizzleRepository },
  ],
  exports: [ComplianceService, ShadowItFindingsService],
})
export class ComplianceModule {}
