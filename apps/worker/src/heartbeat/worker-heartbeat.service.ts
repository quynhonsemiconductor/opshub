import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { hostname } from 'node:os';
import { CacheService } from '@quynhonsemiconductor/platform-cache';
import {
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_HEARTBEAT_KEY_PREFIX,
  WORKER_HEARTBEAT_TTL_SECONDS,
} from './worker-heartbeat.constants';

/**
 * Proves the worker process is alive and connected to the cache, from outside the process.
 *
 * The worker has no HTTP surface, so it cannot answer a probe. Instead it writes its own timestamp to the shared Valkey under a key
 * that expires: the value is the last beat, and a missing key (or one older than the TTL) means no live replica. The cache is the store
 * because it is already required by the worker and needs no migration. A failed write is logged and retried on the next tick; it never
 * stops the worker.
 */
@Injectable()
export class WorkerHeartbeatService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkerHeartbeatService.name);
  private readonly key = `${WORKER_HEARTBEAT_KEY_PREFIX}${hostname()}`;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly cache: CacheService) {}

  onModuleInit(): void {
    void this.beat();
    this.timer = setInterval(() => void this.beat(), WORKER_HEARTBEAT_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** The key this replica writes. Exposed so tests and the check command agree on the name. */
  get heartbeatKey(): string {
    return this.key;
  }

  private async beat(): Promise<void> {
    try {
      await this.cache.set(this.key, new Date().toISOString(), WORKER_HEARTBEAT_TTL_SECONDS);
    } catch (err) {
      this.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Worker heartbeat write failed',
      );
    }
  }
}
