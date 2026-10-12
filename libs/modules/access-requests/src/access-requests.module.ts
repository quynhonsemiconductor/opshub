import { Module } from '@nestjs/common';
import { AuditModule } from '@modules/audit';
import { AccessRequestService } from './application/access-request.service';
import { AccessRequestTypeDef } from './application/access-request.type-def';
import { AccessRequestsController } from './interface/http/access-requests.controller';
import { AccessRequestDrizzleRepository } from './infrastructure/persistence/access-request.drizzle-repository';
import { ACCESS_REQUEST_REPOSITORY } from './domain/ports/access-request.repository';

@Module({
  imports: [AuditModule],
  controllers: [AccessRequestsController],
  providers: [
    AccessRequestService,
    AccessRequestTypeDef,
    { provide: ACCESS_REQUEST_REPOSITORY, useClass: AccessRequestDrizzleRepository },
  ],
  exports: [AccessRequestService],
})
export class AccessRequestsModule {}
