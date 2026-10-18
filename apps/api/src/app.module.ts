import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ZodValidationPipe } from 'nestjs-zod';
import {
  PlatformModule,
  GlobalExceptionFilter,
  HttpLoggingInterceptor,
  IdempotencyInterceptor,
  RateLimitGuard,
  SanitizationPipe,
} from '@platform';
import { AuthModule, EmployeesModule } from '@modules/identity';
import { AuthzModule } from '@modules/authz';
import { AssetsModule } from '@modules/assets';
import { AccessRequestsModule } from '@modules/access-requests';
import { ComplianceModule } from '@modules/compliance';
import { WorkforceModule } from '@modules/workforce';
import { AuditModule } from '@modules/audit';
import { NotificationsModule } from '@modules/notifications';
import { RequestsModule } from '@modules/requests';
import { ReportsModule } from '@modules/reports';
import { WebhooksModule } from '@modules/webhooks';
import { LicenseModule } from '@modules/license';
import { CatalogModule } from '@modules/catalog';
import { DocumentsModule } from '@modules/documents';
import { PositionsModule } from '@modules/positions';
import { ContractsModule } from '@modules/contracts';
import { TrainingModule } from '@modules/training';
import { PerformanceModule } from '@modules/performance';
import { IsmsModule } from '@modules/isms';
import { QmsModule } from '@modules/qms';
import { AiModule } from '@modules/ai';
import { SecurityPostureModule } from '@modules/security-posture';

@Module({
  imports: [
    // Logging is NOT wired here: `createHttpApp` (main.ts) registers the shared pino logger around this module.
    PlatformModule,
    AuditModule,
    NotificationsModule,
    EmployeesModule,
    AuthModule,
    AuthzModule,
    AssetsModule,
    AccessRequestsModule,
    ComplianceModule,
    WorkforceModule,
    RequestsModule,
    ReportsModule,
    WebhooksModule,
    LicenseModule,
    CatalogModule,
    DocumentsModule,
    PositionsModule,
    ContractsModule,
    TrainingModule,
    PerformanceModule,
    IsmsModule,
    QmsModule,
    AiModule,
    SecurityPostureModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_INTERCEPTOR, useClass: HttpLoggingInterceptor },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    { provide: APP_PIPE, useClass: SanitizationPipe }, // strip XSS before validation
    { provide: APP_PIPE, useClass: ZodValidationPipe },
  ],
})
export class AppModule {}
