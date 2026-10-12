import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { trace, isSpanContextValid } from '@opentelemetry/api';
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
    LoggerModule.forRootAsync({
      inject: [AppConfigService, RequestContextService],
      useFactory: (config: AppConfigService, ctx: RequestContextService) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL'),
          autoLogging: false,
          transport: config.get('LOG_PRETTY')
            ? { target: 'pino-pretty', options: { singleLine: true } }
            : undefined,
          mixin: () => {
            const result: Record<string, unknown> = {};
            // Trace-log correlation: link every log line to the active OTel span
            const span = trace.getActiveSpan();
            if (span) {
              const spanCtx = span.spanContext();
              if (isSpanContextValid(spanCtx)) {
                result['trace.id'] = spanCtx.traceId;
                result['span.id'] = spanCtx.spanId;
              }
            }
            const correlationId = ctx.getCorrelationId();
            const userId = ctx.getUserId();
            if (correlationId) result['correlationId'] = correlationId;
            if (userId) result['userId'] = userId;
            return result;
          },
          redact: ['req.headers.authorization', 'req.headers.cookie'],
        },
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
