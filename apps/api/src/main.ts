// `.env` FIRST, above the OTel bootstrap: that bootstrap reads process.env directly,
// and @nestjs/config does not load the file until ConfigModule initialises — far too
// late. See @quynhonsemiconductor/platform-runtime's own header: this MUST stay
// above the OTel bootstrap, and MUST come from the subpath, not the package root.
import '@quynhonsemiconductor/platform-runtime/load-env';
// OTel must be imported before any other module — registers auto-instrumentation
import { shutdownOtel } from './otel';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger as PinoLogger } from 'nestjs-pino';
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

  await bootstrapApp(app);

  const config = app.get(AppConfigService);
  const logger = app.get(PinoLogger);
  const port = config.get('PORT');
  const host = config.get('HOST');

  await app.listen(port, host);
  logger.log(`OpsHub API listening on http://${host}:${port} (docs: /api/docs)`);

  // ── Process signal handlers ────────────────────────────────────────────────
  // ECS sends SIGTERM on task replacement; Docker Ctrl-C sends SIGINT.
  // Order: flush OTel spans FIRST, then close NestJS (drains DB pool, Redis, etc.).
  const shutdown = async (signal: string): Promise<void> => {
    logger.log(`Received ${signal} — shutting down gracefully`, 'Bootstrap');
    try {
      await shutdownOtel();
      await app.close();
      logger.log('Shutdown complete', 'Bootstrap');
    } catch (err) {
      logger.error({ msg: 'Error during shutdown', err }, 'Bootstrap');
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

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
