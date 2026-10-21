import { Global, Module } from '@nestjs/common';
import { CacheModule } from '@quynhonsemiconductor/platform-cache';
import { RequestContextService } from '@quynhonsemiconductor/observability';
import { AppConfigModule } from './config/config.module';
import { AppConfigService, WorkerConfigService } from './config/app-config.service';
import { DatabaseModule } from './database/database.module';
import { SessionAuthGuard } from './auth/session-principal.guard';
import { ScopeEvaluator } from './auth/scope-evaluator';
import { ResourceScopeResolver } from './auth/resource-scope.resolver';
import { AuthzService } from './auth/authz.service';
import { PolicyGuard } from './auth/policy.guard';
import { RequestRegistry } from './requests/request-registry';
import { RequestEngine } from './requests/request-engine.service';
import { HttpLoggingInterceptor } from './http/http-logging.interceptor';
import { ResilienceService } from './resilience/resilience.service';
import { EMAIL_PROVIDER } from './email/email.provider';
import { DiscoveryModule } from '@nestjs/core';
import { ExclusiveJob } from '@quynhonsemiconductor/platform-runtime';
import { ActorScope } from './auth/actor-scope.service';
import { RouteAuthzAudit } from './auth/route-authz-audit';
import { DevEmailProvider } from './email/providers/dev.provider';
import { ResendEmailProvider } from './email/providers/resend.provider';
import { SesEmailProvider } from './email/providers/ses.provider';
import { GraphEmailProvider } from './email/providers/graph.provider';
import { SmtpEmailProvider } from './email/providers/smtp.provider';
import { EmailService } from './email/email.service';
import { EmailSchedulerService } from './email/email-scheduler.service';
import { EmailDeliveryService } from './email/email-delivery.service';
import { NotificationSchedulerService } from './notifications/notification-scheduler.service';
import { NotificationPubSubService } from './notifications/notification-pubsub.service';
import { OutboxWakeService } from './outbox/outbox-wake.service';
import { DelegationService } from './authz/delegation.service';
import { WebhookEnqueueService } from './webhooks/webhook-enqueue.service';
import { StorageService } from './storage/storage.service';
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
    // Single shared Valkey/Redis client (@quynhonsemiconductor/platform-cache), registered
    // globally so every consumer (rate-limit, idempotency, health, pub/sub) and
    // the identity 8 session store and rate limits share one connection.
    // Optional mode: when VALKEY_URL is unset the cache is disabled and all
    // consumers fail open (opshub runs without a hard Redis dependency).
    CacheModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        url: config.get('VALKEY_URL'),
        keyPrefix: config.get('REDIS_KEY_PREFIX'),
        mode: 'optional' as const,
      }),
    }),
  ],
  providers: [
    // Refuses to finish bootstrapping if any route declares no authorization. A provider so
    // it runs for every app that imports this module, with no call site to forget.
    RouteAuthzAudit,
    RequestContextService,
    SessionAuthGuard,
    ScopeEvaluator,
    ResourceScopeResolver,
    AuthzService,
    ActorScope,
    PolicyGuard,
    RequestRegistry,
    RequestEngine,
    HttpLoggingInterceptor,
    ResilienceService,
    // Worker only (see OutboxWakeService): the API holds no LISTEN connection.
    OutboxWakeService,
    {
      provide: EMAIL_PROVIDER,
      inject: [AppConfigService, WorkerConfigService],
      useFactory: (config: AppConfigService, worker: WorkerConfigService) => {
        const provider = config.get('EMAIL_PROVIDER');
        if (provider === 'graph') {
          /*
           * The WORKER's credential, read through the worker-typed config: the API's schema refuses every GRAPH_* variable, so there it
           * reads `undefined` and the provider (which builds its transport on the first send, and the API never sends) stays inert. The
           * worker's schema requires them for this provider, and `EmailRelayService` calls `assertReady()` when it starts.
           */
          return new GraphEmailProvider({
            sender: config.get('MAIL_GRAPH_SENDER') ?? '',
            tenantId: worker.get('ENTRA_TENANT_ID'),
            clientId: worker.get('GRAPH_CLIENT_ID'),
            certificate: worker.get('GRAPH_CLIENT_CERTIFICATE'),
            federatedTokenFile: worker.get('GRAPH_FEDERATED_TOKEN_FILE'),
            nodeEnv: config.get('NODE_ENV'),
          });
        }
        if (provider === 'smtp') {
          // Development only (Mailpit). Built lazily, like graph: the worker's relay calls `assertReady()` at start.
          return new SmtpEmailProvider({
            host: config.get('MAIL_SMTP_HOST') ?? '',
            port: config.get('MAIL_SMTP_PORT') ?? 1025,
            from: config.get('MAIL_FROM_EMAIL') ?? '',
            nodeEnv: config.get('NODE_ENV'),
          });
        }
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
    EntityAttachmentsService,
    ActorScope,
    ExclusiveJob,
    AppConfigModule,
    DatabaseModule,
    RequestContextService,
    SessionAuthGuard,
    ScopeEvaluator,
    ResourceScopeResolver,
    AuthzService,
    PolicyGuard,
    RequestRegistry,
    RequestEngine,
    HttpLoggingInterceptor,
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
