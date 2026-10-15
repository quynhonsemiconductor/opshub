import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { createLoggerOptions } from '@quynhonsemiconductor/observability';
import { LoggerModule } from 'nestjs-pino';
import { ZodValidationPipe } from 'nestjs-zod';
import {
  PlatformModule,
  AppConfigService,
  GlobalExceptionFilter,
  REQUEST_CONTEXT,
  HttpLoggingInterceptor,
  IdempotencyInterceptor,
  RequestContextService,
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
    // The shared logger options (`@quynhonsemiconductor/observability`): trace correlation, the request context's
    // `userId` / `correlationId` on every line, the shared redaction list, and the `service` / `env` / `version`
    // fields. `autoLogging` is off: HttpLoggingInterceptor writes the one summary line per request.
    LoggerModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) =>
        createLoggerOptions({
          serviceName: config.get('OTEL_SERVICE_NAME'),
          nodeEnv: config.get('NODE_ENV'),
          // the DEPLOYMENT environment for the `env` field; NODE_ENV is production everywhere on purpose
          deploymentEnv: config.get('DEPLOYMENT_ENV'),
          serviceVersion: config.get('SERVICE_VERSION'),
          level: config.get('LOG_LEVEL'),
          pretty: config.get('LOG_PRETTY'),
        }),
    }),
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
    // Bind the shared filter's request-context port to observability's request-context store: the one
    // `enableCorrelationId` (platform-http) seeds for every request, and the worker's `withJobContext` for jobs.
    { provide: REQUEST_CONTEXT, useExisting: RequestContextService },
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_INTERCEPTOR, useClass: HttpLoggingInterceptor },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    { provide: APP_PIPE, useClass: SanitizationPipe }, // strip XSS before validation
    { provide: APP_PIPE, useClass: ZodValidationPipe },
  ],
})
export class AppModule {}
