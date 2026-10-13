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
import { Logger as PinoLogger } from 'nestjs-pino';
import { enableGracefulShutdown } from '@quynhonsemiconductor/platform-runtime';
import { WorkerModule } from './worker.module';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(PinoLogger));

  const logger = app.get(PinoLogger);
  logger.log('OpsHub worker started (outbox relay + scheduled jobs)', 'Bootstrap');

  // SIGTERM / SIGINT: `app.close()` (relays and crons stop, then the pool and cache close), telemetry flush, exit,
  // bounded by SHUTDOWN_TIMEOUT_MS. The worker serves no HTTP, so there is no readiness flip or drain. The ONE owner
  // of shutdown: no `app.enableShutdownHooks()` and no handler of our own, which closed the application twice.
  enableGracefulShutdown(app);

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
