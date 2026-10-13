// `.env` FIRST, above the OTel bootstrap: that bootstrap reads process.env directly,
// and @nestjs/config does not load the file until ConfigModule initialises — far too
// late. See @quynhonsemiconductor/platform-runtime's own header: this MUST stay
// above the OTel bootstrap, and MUST come from the subpath, not the package root.
import '@quynhonsemiconductor/platform-runtime/load-env';
// The process role, before anything that loads @platform (which validates the environment on import).
import './role';
// OTel must be imported before any other module — registers auto-instrumentation
import './otel';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger as PinoLogger } from 'nestjs-pino';
import { enableCorrelationId } from '@quynhonsemiconductor/platform-http';
import { enableGracefulShutdown } from '@quynhonsemiconductor/platform-runtime';
import { AppModule } from './app.module';
import { AppConfigService } from '@platform';
import { bootstrapApp } from './bootstrap/app.bootstrap';

async function main(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      // Disable Fastify's built-in logger — pino handles all logging; without this,
      // Fastify's pinoHttp runs in parallel with nestjs-pino producing duplicate lines.
      logger: false,
      trustProxy: true,
      // Explicit body limit — prevents zip-bomb / oversized payload attacks (OWASP A04)
      bodyLimit: 10 * 1024 * 1024, // 10 MB; tighten per-route if needed
    }),
    { bufferLogs: true },
  );

  // Before anything else in the Nest pipeline: one correlation id per request, from its first byte (also
  // the `/api/auth/*` mount, which no Nest middleware sees), in observability's request context.
  enableCorrelationId(app);
  await bootstrapApp(app);

  const config = app.get(AppConfigService);
  const logger = app.get(PinoLogger);
  const port = config.get('PORT');
  const host = config.get('HOST');

  // SIGTERM / SIGINT (ECS and Kubernetes send one on task replacement; Ctrl-C the other): /readyz answers 503, the
  // endpoint-removal delay, HTTP drains, `app.close()` runs the close hooks (pool, cache), telemetry is flushed and
  // the process exits, all bounded by SHUTDOWN_TIMEOUT_MS. The ONE owner of shutdown: no `app.enableShutdownHooks()`
  // (it would close the app on the signal at once, outside this sequence) and no handler of our own (that closed the
  // application a second time). Before `listen()`, as the package requires.
  enableGracefulShutdown(app);

  await app.listen(port, host);
  logger.log(`OpsHub API listening on http://${host}:${port} (docs: /api/docs)`);

  process.on('unhandledRejection', (reason: unknown) => {
    logger.error({ msg: 'Unhandled promise rejection', reason }, 'Bootstrap');
  });

  process.on('uncaughtException', (error: Error) => {
    logger.error({ msg: 'Uncaught exception', error }, 'Bootstrap');
    process.exit(1);
  });
}

main().catch((err) => {
  console.error('Fatal bootstrap error', err);
  process.exit(1);
});
