/**
 * The outbox wake-up hint: PostgreSQL LISTEN / NOTIFY.
 *
 * A writer calls {@link notifyOutbox} INSIDE the transaction that inserts the outbox row. NOTIFY is delivered at COMMIT,
 * so a listener is never woken for a row that does not exist, and a rolled-back transaction wakes nothing. The worker's
 * {@link OutboxWakeListener} LISTENs and runs the relays early.
 *
 * The hint is only a hint. Polling (each relay's cron) stays the source of truth: a notify that is lost (the listener was
 * down, the connection dropped between commit and delivery) still leaves the row in its table, and the next poll takes it.
 *
 * The listener holds its OWN connection, outside the pool. A pooled connection can be checked out for a query, and LISTEN
 * is per session: a LISTEN on a pooled client would be lost the moment the pool handed the client to someone else.
 */
import { sql } from 'drizzle-orm';
import { Client, type ClientConfig } from 'pg';
import type { DbExecutor } from '../database/drizzle.provider';

/** The one channel every outbox shares. The payload says which relay to wake (its {@link wakeKind}). */
export const OUTBOX_WAKE_CHANNEL = 'outbox';

/** Shown in pg_stat_activity, so an operator can tell the listener's connection from the pool's. */
export const OUTBOX_WAKE_APPLICATION_NAME = 'opshub-outbox-wake';

/**
 * Tell the listeners that the outbox `kind` has a row to relay. Call it in the SAME transaction as the insert: `tx` is the
 * caller's transaction, and the notify is held until that transaction commits.
 */
export async function notifyOutbox(tx: DbExecutor, kind: string): Promise<void> {
  await tx.execute(sql`select pg_notify(${OUTBOX_WAKE_CHANNEL}, ${kind})`);
}

/**
 * The relays a notify with this `kind` wakes: those whose wakeKind matches. A relay with no wakeKind is never woken early;
 * it runs on its cron alone.
 */
export function relaysWokenBy<R extends { readonly wakeKind: string | undefined }>(
  kind: string,
  relays: readonly R[],
): R[] {
  return relays.filter((relay) => relay.wakeKind === kind);
}

export interface WakeLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface OutboxWakeListenerOptions {
  /** The connection settings, the same ones the pool uses. `application_name` and keepalive are set by the listener. */
  config: ClientConfig;
  logger: WakeLogger;
  /** Built by default from `pg`. A test passes a fake. */
  createClient?: (config: ClientConfig) => Client;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** How often the LISTEN connection is probed with `SELECT 1`. */
  watchdogIntervalMs?: number;
  /** How long a probe may take before the connection is judged dead. */
  watchdogTimeoutMs?: number;
}

/**
 * LISTENs on {@link OUTBOX_WAKE_CHANNEL} and calls each registered handler with the payload (the outbox's kind).
 *
 * A dropped connection is rebuilt with exponential backoff (minBackoffMs, doubling, capped at maxBackoffMs). The backoff
 * resets once a connection has LISTENed again. Until then nothing is woken, and the relays' cron polling carries the load.
 *
 * An idle LISTEN socket can go half-open (a failover, a NAT or security-group idle drop) with no 'error' and no 'end'. TCP
 * keepalive shortens that, and a watchdog `SELECT 1` on the same connection settles it: a probe that fails or does not
 * answer in time drops the connection and reconnects, instead of leaving the listener deaf until a restart.
 */
export class OutboxWakeListener {
  private client: Client | null = null;
  /** True once LISTEN is acknowledged: a notify sent before this is not seen, and the poll covers it. */
  private ready = false;
  private stopped = true;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private backoffMs: number;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly watchdogIntervalMs: number;
  private readonly watchdogTimeoutMs: number;
  private readonly handlers = new Set<(kind: string) => void>();

  constructor(private readonly opts: OutboxWakeListenerOptions) {
    this.minBackoffMs = opts.minBackoffMs ?? 1_000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000;
    this.watchdogIntervalMs = opts.watchdogIntervalMs ?? 30_000;
    this.watchdogTimeoutMs = opts.watchdogTimeoutMs ?? 5_000;
    this.backoffMs = this.minBackoffMs;
  }

  /** Register a handler for every wake. Returns the unregister function. */
  onWake(handler: (kind: string) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /** Connect and LISTEN. Resolves once the first attempt has settled, whether or not it connected. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.stopWatchdog();
    const client = this.client;
    this.client = null;
    this.ready = false;
    await client?.end().catch(() => undefined);
  }

  /** Whether the connection is LISTENing right now (false while connecting or reconnecting). */
  get listening(): boolean {
    return this.ready;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const create = this.opts.createClient ?? ((config: ClientConfig) => new Client(config));
    const client = create({
      ...this.opts.config,
      application_name: OUTBOX_WAKE_APPLICATION_NAME,
      // Turn the OS keepalive on, so an idle socket is probed by the kernel too. The watchdog below is the real check.
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
    });
    this.client = client;
    client.on('notification', (message) => {
      if (message.channel !== OUTBOX_WAKE_CHANNEL) return;
      for (const handler of this.handlers) {
        try {
          handler(message.payload ?? '');
        } catch (err) {
          this.opts.logger.error(`outbox wake handler failed: ${describe(err)}`);
        }
      }
    });
    client.on('error', (err: Error) => this.lost(client, err));
    client.on('end', () => this.lost(client));
    try {
      await client.connect();
      await client.query(`LISTEN ${OUTBOX_WAKE_CHANNEL}`);
      this.ready = true;
      this.backoffMs = this.minBackoffMs;
      this.startWatchdog(client);
      this.opts.logger.log('outbox wake listener connected');
    } catch (err) {
      this.lost(client, err);
    }
  }

  private startWatchdog(client: Client): void {
    this.stopWatchdog();
    this.watchdog = setInterval(() => void this.probe(client), this.watchdogIntervalMs);
  }

  private stopWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  /** One `SELECT 1` on the LISTEN connection. A failure, or no answer within the timeout, means the socket is dead. */
  private async probe(client: Client): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        client.query('SELECT 1'),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error(`no answer to the watchdog within ${this.watchdogTimeoutMs} ms`)),
            this.watchdogTimeoutMs,
          );
        }),
      ]);
    } catch (err) {
      this.lost(client, err);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Drop `client` and schedule a reconnect. A stale client (already replaced) is ignored: 'error' and 'end' both fire. */
  private lost(client: Client, err?: unknown): void {
    if (client !== this.client || this.stopped) return;
    this.client = null;
    this.ready = false;
    this.stopWatchdog();
    client.end().catch(() => undefined);
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    const cause = err ? describe(err) : 'connection ended';
    this.opts.logger.warn(`outbox wake listener lost (${cause}); reconnecting in ${delay} ms`);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connect();
    }, delay);
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
