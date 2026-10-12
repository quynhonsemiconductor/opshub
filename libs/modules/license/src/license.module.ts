import { Module } from '@nestjs/common';
import { AuditModule } from '@modules/audit';
import { LicenseService } from './application/license.service';
import { LicensesController } from './interface/http/licenses.controller';
import { LicenseDrizzleRepository } from './infrastructure/persistence/license.drizzle-repository';
import { LICENSE_REPOSITORY } from './domain/ports/license.repository';

@Module({
  imports: [AuditModule],
  controllers: [LicensesController],
  providers: [LicenseService, { provide: LICENSE_REPOSITORY, useClass: LicenseDrizzleRepository }],
  exports: [LicenseService],
})
export class LicenseModule {}
