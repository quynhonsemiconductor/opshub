/**
 * Shutdown with a signed-in tab open.
 *
 * `GET /v1/notifications/stream` hijacks its reply and never ends. `fastify.close()` waits for every connection,
 * and the default `forceCloseConnections: 'idle'` spares a response in flight, so with one open stream
 * `app.close()` hangs until `enableGracefulShutdown`'s deadline (SHUTDOWN_TIMEOUT_MS, 25 s), which exits 1 before
 * the pool and the cache are closed. A deploy with a signed-in tab did exactly that.
 *
 * The fix is a Fastify `preClose` hook in the notifications module: send `event: reconnect`, end the streams.
 * This spec holds a real stream open over a real socket and closes the application.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d`, `pnpm db:migrate`, `pnpm db:seed`.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE, createTestApp, login } from './support/harness';

const CLOSE_BUDGET_MS = 5_000;

let app: NestFastifyApplication;
let closed = false;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  if (!closed) await app.close();
});

describe('shutdown with an open notification stream', () => {
  it('app.close() ends the stream with a reconnect event instead of hanging until the deadline', async () => {
    const session = await login(app, FIXTURE.NO_PERMISSIONS);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.getHttpServer().address() as AddressInfo;

    let received = '';
    const streamEnded = new Promise<void>((resolve) => {
      const req = http.get(
        {
          host: '127.0.0.1',
          port,
          path: '/v1/notifications/stream',
          headers: { cookie: session.cookieHeader, accept: 'text/event-stream' },
        },
        (res) => {
          expect(res.statusCode).toBe(200);
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            received += chunk;
          });
          res.on('end', resolve);
          res.on('close', resolve);
        },
      );
      req.on('error', () => resolve());
    });

    // The stream is established once the `connected` event has arrived.
    const deadline = Date.now() + 5_000;
    while (!received.includes('event: connected') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(received).toContain('event: connected');

    const started = Date.now();
    const outcome = await Promise.race([
      app.close().then(() => 'closed' as const),
      new Promise<'hung'>((r) => setTimeout(() => r('hung'), CLOSE_BUDGET_MS)),
    ]);
    closed = outcome === 'closed';

    expect(outcome, `app.close() still pending after ${Date.now() - started} ms`).toBe('closed');
    await streamEnded;
    expect(received).toContain('event: reconnect');
  }, 30_000);
});
