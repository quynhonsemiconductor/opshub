/**
 * The open notification streams, and what happens to them when the server closes.
 *
 * `GET /v1/notifications/stream` hijacks its reply and never ends on its own. `fastify.close()` waits for every
 * connection, and Fastify's default `forceCloseConnections: 'idle'` spares a response still in flight, so one signed-in
 * tab kept `app.close()` pending until `enableGracefulShutdown`'s deadline (SHUTDOWN_TIMEOUT_MS), which exits 1 BEFORE
 * the pool and the cache are closed. A `preClose` hook runs first thing in `close()`, before the listener is closed:
 * it tells each client to reconnect and ends the response, so `close()` can finish and the usual order follows.
 *
 * A browser's EventSource reconnects by itself after the stream ends (and the new request meets a 503 or another
 * instance, which is exactly what a deploy wants); `reconnect` is for clients that would rather act than guess.
 */
import { Injectable, OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';

export const SSE_RECONNECT_EVENT = 'reconnect';

@Injectable()
export class SseStreams implements OnModuleInit {
  private readonly open = new Set<ServerResponse>();

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  onModuleInit(): void {
    const adapter: { getInstance?: () => unknown } | undefined = this.adapterHost.httpAdapter;
    const fastify = adapter?.getInstance?.() as FastifyInstance | undefined;
    // A non-Fastify adapter (or none: the worker does not serve HTTP) has no `preClose` to hook.
    if (!fastify || typeof fastify.addHook !== 'function') return;
    fastify.addHook('preClose', () => {
      this.endAll();
      return Promise.resolve();
    });
  }

  /** Track a stream until it closes. */
  register(raw: ServerResponse): void {
    this.open.add(raw);
    raw.once('close', () => this.open.delete(raw));
  }

  /** Tell every open client to reconnect, then end the response. */
  endAll(): void {
    for (const raw of [...this.open]) {
      this.open.delete(raw);
      if (raw.writable) {
        raw.write(`event: ${SSE_RECONNECT_EVENT}\ndata: {}\n\n`);
        raw.end();
      }
    }
  }
}
