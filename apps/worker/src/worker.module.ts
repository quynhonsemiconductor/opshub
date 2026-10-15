import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PlatformModule } from '@platform';
import { AuditModule } from '@modules/audit';
import { NotificationsModule } from '@modules/notifications';
import { WebhooksModule } from '@modules/webhooks';
import { ComplianceModule } from '@modules/compliance';
// By path, not from the barrel: the API must not be able to import the module that holds the Graph client.
import { GraphModule } from '@modules/graph/graph.module';
import { SecurityPostureModule } from '@modules/security-posture';
import { ContractsModule } from '@modules/contracts';
import { IsmsModule } from '@modules/isms';
import { RequestExpiryCron } from './cron/request-expiry.cron';
import { SlaBreachCron } from './cron/sla-breach.cron';
import { DelegationExpiryCron } from './cron/delegation-expiry.cron';
import { ContractExpiryCron } from './cron/contract-expiry.cron';
import { StorageCleanupCron } from './cron/storage-cleanup.cron';
import { ReviewDueCron } from './cron/review-due.cron';
import { BounceFeedbackService } from './email/bounce-feedback.service';

@Module({
  imports: [
    // Logging is NOT wired here: `createWorkerApp` (main.ts) registers the shared pino logger around this module.
    ScheduleModule.forRoot(),
    PlatformModule,
    AuditModule,
    NotificationsModule,
    WebhooksModule,
    ComplianceModule,
    SecurityPostureModule,
    GraphModule,
    ContractsModule,
    IsmsModule,
  ],
  providers: [
    BounceFeedbackService,
    RequestExpiryCron,
    SlaBreachCron,
    DelegationExpiryCron,
    ContractExpiryCron,
    StorageCleanupCron,
    ReviewDueCron,
  ],
})
export class WorkerModule {}
