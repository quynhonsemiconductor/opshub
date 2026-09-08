// `.env` FIRST, above the OTel bootstrap: that bootstrap reads process.env directly,
// and @nestjs/config does not load the file until ConfigModule initialises — far too
// late. See @quynhonsemiconductor/platform-runtime's own header: this MUST stay
// above the OTel bootstrap, and MUST come from the subpath, not the package root.
import '@quynhonsemiconductor/platform-runtime/load-env';
// OTel must be imported before any other module — registers auto-instrumentation
import { shutdownOtel } from './otel';
import { NestFactory } from '@nestjs/core';
import { Logger as PinoLogger } from 'nestjs-pino';
import { WorkerModule } from './worker.module';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(PinoLogger));

  const logger = app.get(PinoLogger);
  logger.log('OpsHub worker started (outbox relay + scheduled jobs)', 'Bootstrap');

  app.enableShutdownHooks();

  // ── Process signal handlers ────────────────────────────────────────────────
  // ECS sends SIGTERM on task replacement; Docker Ctrl-C sends SIGINT.
  const shutdown = async (signal: string): Promise<void> => {
    logger.log(`Received ${signal} — shutting down worker`, 'Bootstrap');
    try {
      await shutdownOtel();
      await app.close();
      logger.log('Worker shutdown complete', 'Bootstrap');
    } catch (err) {
      logger.error({ msg: 'Error during worker shutdown', err }, 'Bootstrap');
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
  console.error('Fatal worker bootstrap error', err);
  process.exit(1);
});
