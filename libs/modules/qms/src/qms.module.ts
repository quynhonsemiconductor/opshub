import { Module } from '@nestjs/common';
import { AuditModule } from '@modules/audit';
import { IdentityModule } from '@modules/identity';
import { DocumentsModule } from '@modules/documents';
import { IsmsModule } from '@modules/isms';
import { NonconformanceService } from './application/nonconformance.service';
import { CapaService } from './application/capa.service';
import { InternalAuditService } from './application/internal-audit.service';
import { ManagementReviewService } from './application/management-review.service';
import { NonconformanceController } from './interface/http/nonconformance.controller';
import { CapaController } from './interface/http/capa.controller';
import { InternalAuditController } from './interface/http/internal-audit.controller';
import { ManagementReviewController } from './interface/http/management-review.controller';
import { NonconformanceDrizzleRepository } from './infrastructure/persistence/nonconformance.drizzle-repository';
import { CapaDrizzleRepository } from './infrastructure/persistence/capa.drizzle-repository';
import { InternalAuditDrizzleRepository } from './infrastructure/persistence/internal-audit.drizzle-repository';
import { ManagementReviewDrizzleRepository } from './infrastructure/persistence/management-review.drizzle-repository';
import {
  CAPA_REPOSITORY,
  INTERNAL_AUDIT_REPOSITORY,
  MANAGEMENT_REVIEW_REPOSITORY,
  NONCONFORMANCE_REPOSITORY,
} from './domain/ports/qms.repository';

@Module({
  // IdentityModule for EmployeeService: the controllers check an owner exists before writing, since
  // `owner_id` carries no cross-schema FK.
  //
  // The two services depend on each other's REPOSITORIES, not on each other — the closure gate reads
  // CAPA rows and the CAPA service reads the finding. That keeps the graph acyclic, so neither needs
  // a `forwardRef`, and it means neither service can quietly reach past the other's guards.
  // IsmsModule for the management review's §9.3.2 agenda: the clause's inputs include the performance
  // of external providers and the effectiveness of actions on risks, which the vendor and control
  // services own. Composed rather than copied — a second copy of those numbers disagrees with the
  // register within a day. No cycle: IsmsModule imports only AuditModule and IdentityModule.
  // DocumentsModule for DocumentsService: an internal audit's report is a controlled document,
  // and the reference to it carries no cross-schema FK.
  imports: [AuditModule, IdentityModule, IsmsModule, DocumentsModule],
  controllers: [
    NonconformanceController,
    CapaController,
    InternalAuditController,
    ManagementReviewController,
  ],
  providers: [
    NonconformanceService,
    CapaService,
    InternalAuditService,
    ManagementReviewService,
    { provide: NONCONFORMANCE_REPOSITORY, useClass: NonconformanceDrizzleRepository },
    { provide: CAPA_REPOSITORY, useClass: CapaDrizzleRepository },
    { provide: INTERNAL_AUDIT_REPOSITORY, useClass: InternalAuditDrizzleRepository },
    { provide: MANAGEMENT_REVIEW_REPOSITORY, useClass: ManagementReviewDrizzleRepository },
  ],
  exports: [NonconformanceService, CapaService, InternalAuditService, ManagementReviewService],
})
export class QmsModule {}
