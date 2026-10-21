/**
 * OutboxWakeService — the worker's LISTEN connection, and the bridge from a NOTIFY to the relays.
 *
 * Every AbstractOutboxRelay provider in the app is woken on a notify: its relay() runs now instead of at its next cron
 * tick. The cron stays. A missed notify (the listener was down, the connection dropped) is recovered by the next tick.
 *
 * The relays are found through DiscoveryService, so no relay constructor has to take this service: a relay gains the
 * wake-up by existing as a provider, and nothing else.
 */
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { AppConfigService } from '../config/app-config.service';
import { databaseClientConfig } from '../database/drizzle.provider';
import { getProcessRole } from '../config/process-role';
import { AbstractOutboxRelay } from './abstract-outbox-relay';
import { OutboxWakeListener, relaysWokenBy } from './outbox-wake';

@Injectable()
export class OutboxWakeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxWakeService.name);
  private listener: OutboxWakeListener | null = null;

  constructor(
    private readonly config: AppConfigService,
    private readonly discovery: DiscoveryService,
  ) {}

  onModuleInit(): void {
    // Only the worker's relays send, so only the worker listens. The API writes rows and notifies; a wake in the API would run a relay there.
    if (getProcessRole() !== 'worker') return;

    const relays = this.discovery
      .getProviders()
      .map((wrapper): unknown => wrapper.instance)
      .filter(
        (instance): instance is AbstractOutboxRelay<never> =>
          instance instanceof AbstractOutboxRelay,
      );

    this.listener = new OutboxWakeListener({
      config: databaseClientConfig(this.config),
      logger: {
        log: (message) => this.logger.log(message),
        warn: (message) => this.logger.warn(message),
        error: (message) => this.logger.error(message),
      },
    });
    this.listener.onWake((kind) => {
      for (const relay of relaysWokenBy(kind, relays)) {
        relay
          .relay()
          .catch((err: unknown) =>
            this.logger.error({ err }, 'Outbox relay woken by notify failed'),
          );
      }
    });
    // Not awaited: a database that is down at boot must not hold the worker's start. The listener keeps retrying.
    void this.listener.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.listener?.stop();
  }
}
