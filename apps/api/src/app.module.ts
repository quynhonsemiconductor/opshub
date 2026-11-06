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
import { DoorModule } from '@modules/door';
import { MetaController } from './meta/meta.controller';
import { McpModule } from './mcp/mcp.module';

@Module({
  imports: [
    // Logging is NOT wired here: `createHttpApp` (main.ts) registers the shared pino logger around this module.
    PlatformModule,
    // BEFORE AuthModule: global guard order is module order, and McpPrincipalGuard must run before
    // identity's SessionGuard (see mcp.module.ts). It does nothing on a request with no MCP token.
    McpModule,
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
    DoorModule,
  ],
  controllers: [MetaController],
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
