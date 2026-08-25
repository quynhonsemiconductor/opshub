import { Global, Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtModule } from '@nestjs/jwt';
import { TerminusModule } from '@nestjs/terminus';
import { CacheModule } from '@qnsc-vn/platform-cache';
import { AuthTokenCache } from '@qnsc-vn/identity';
import { AppConfigModule } from './config/config.module';
import { AppConfigService } from './config/app-config.service';
import { DatabaseModule } from './database/database.module';
import { RequestContextService } from './context/request-context';
import { JwtStrategy } from './auth/jwt.strategy';
import { JwtAuthGuard } from './auth/jwt.guard';
import { ScopeEvaluator } from './auth/scope-evaluator';
import { ResourceScopeResolver } from './auth/resource-scope.resolver';
import { AuthzService } from './auth/authz.service';
import { PolicyGuard } from './auth/policy.guard';
import { RequestRegistry } from './requests/request-registry';
import { RequestEngine } from './requests/request-engine.service';
import { HealthController } from './observability/health.controller';
import { HttpLoggingInterceptor } from './http/http-logging.interceptor';
import { ResilienceService } from './resilience/resilience.service';
import { EMAIL_PROVIDER } from './email/email.provider';
import { DiscoveryModule } from '@nestjs/core';
import { ExclusiveJob } from './scheduling/exclusive-job.service';
import { ActorScope } from './auth/actor-scope.service';
import { RouteAuthzAudit } from './auth/route-authz-audit';
import { DevEmailProvider } from './email/providers/dev.provider';
import { ResendEmailProvider } from './email/providers/resend.provider';
import { SesEmailProvider } from './email/providers/ses.provider';
import { EmailService } from './email/email.service';
import { EmailSchedulerService } from './email/email-scheduler.service';
import { EmailDeliveryService } from './email/email-delivery.service';
import { NotificationSchedulerService } from './notifications/notification-scheduler.service';
import { NotificationPubSubService } from './notifications/notification-pubsub.service';
import { DelegationService } from './authz/delegation.service';
import { WebhookEnqueueService } from './webhooks/webhook-enqueue.service';
import { StorageService } from './storage/storage.service';
import { GraphClientService } from './graph/graph-client.service';
import { EntityAttachmentsService } from './storage/entity-attachments.service';

/**
 * Platform module — cross-cutting infrastructure shared by every bounded context:
 * config, database, auth, outbox, health, logging, cache, resilience.
 * Imported once by AppModule.
 */
@Global()
@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    // Gives RouteAuthzAudit the controller inventory it scans at bootstrap.
    DiscoveryModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        privateKey: config.get('JWT_PRIVATE_KEY'),
        publicKey: config.get('JWT_PUBLIC_KEY'),
        signOptions: {
          algorithm: 'ES256',
          expiresIn: config.get('JWT_ACCESS_EXPIRY') as unknown as number,
          issuer: config.get('JWT_ISSUER'),
          audience: config.get('JWT_AUDIENCE'),
        },
        verifyOptions: {
          algorithms: ['ES256'],
          issuer: config.get('JWT_ISSUER'),
          audience: config.get('JWT_AUDIENCE'),
        },
      }),
    }),
    // Single shared Valkey/Redis client (@qnsc-vn/platform-cache), registered
    // globally so every consumer (rate-limit, idempotency, health, pub/sub) and
    // the shared identity AuthService/AuthTokenCache share one connection.
    // Optional mode: when REDIS_URL is unset the cache is disabled and all
    // consumers fail open (opshub runs without a hard Redis dependency).
    CacheModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        url: config.get('REDIS_URL'),
        keyPrefix: config.get('REDIS_KEY_PREFIX'),
        mode: 'optional' as const,
      }),
    }),
    TerminusModule,
  ],
  controllers: [HealthController],
  providers: [
    // Refuses to finish bootstrapping if any route declares no authorization. A provider so
    // it runs for every app that imports this module, with no call site to forget.
    RouteAuthzAudit,
    RequestContextService,
    JwtStrategy,
    JwtAuthGuard,
    ScopeEvaluator,
    ResourceScopeResolver,
    AuthzService,
    ActorScope,
    PolicyGuard,
    RequestRegistry,
    RequestEngine,
    HttpLoggingInterceptor,
    AuthTokenCache,
    ResilienceService,
    GraphClientService,
    {
      provide: EMAIL_PROVIDER,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => {
        const provider = config.get('EMAIL_PROVIDER');
        if (provider === 'ses') {
          /*
           * NO KEY TO CHECK, which is the point of choosing SES: the credential is the task role, so
           * there is nothing to forget in a secret store. What CAN be forgotten is the `ses:SendEmail`
           * grant on that role — and that failure surfaces as `AccessDenied` on every send while the
           * service reports healthy, so it is called out in the provider's own docblock rather than
           * guessed at here. `MAIL_FROM_EMAIL` is already refused at boot for any non-dev provider.
           */
          return new SesEmailProvider(
            config.get('AWS_REGION'),
            config.get('SES_CONFIGURATION_SET'),
          );
        }
        if (provider === 'resend') {
          const apiKey = config.get('RESEND_API_KEY');
          if (!apiKey) throw new Error('RESEND_API_KEY is required when EMAIL_PROVIDER=resend');
          return new ResendEmailProvider(apiKey);
        }
        return new DevEmailProvider();
      },
    },
    EmailService,
    EmailSchedulerService,
    EmailDeliveryService,
    NotificationSchedulerService,
    NotificationPubSubService,
    DelegationService,
    WebhookEnqueueService,
    StorageService,
    EntityAttachmentsService,
    ExclusiveJob,
  ],
  exports: [
    StorageService,
    GraphClientService,
    EntityAttachmentsService,
    ActorScope,
    ExclusiveJob,
    AppConfigModule,
    DatabaseModule,
    JwtModule,
    RequestContextService,
    JwtAuthGuard,
    ScopeEvaluator,
    ResourceScopeResolver,
    AuthzService,
    PolicyGuard,
    RequestRegistry,
    RequestEngine,
    HttpLoggingInterceptor,
    AuthTokenCache,
    ResilienceService,
    EmailService,
    EmailSchedulerService,
    EmailDeliveryService,
    NotificationSchedulerService,
    NotificationPubSubService,
    DelegationService,
    WebhookEnqueueService,
  ],
})
export class PlatformModule {}
