/**
 * The Graph client's HTTP behaviour, against a REAL local HTTP server: no SDK retry loop, a hard
 * deadline per request, and leases that are provably longer than the calls they cover.
 *
 * THE RACE THESE CLOSE. The SDK's default RetryHandler retries 429/503/504 up to three times, each wait
 * up to the server's Retry-After (180 s honoured), inside ONE call with no overall bound, and `fetch` has
 * no timeout. With a 3-minute lease on an account task: worker A sends an enable and is throttled; the
 * lease lapses; worker B re-claims, reads the employee as offboarded and disables; A's retried PATCH then
 * lands and re-enables the account — and A's finish loses the fence, so nothing puts it right.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, RetryHandler } from '@microsoft/microsoft-graph-client';
import { afterEach, describe, expect, it } from 'vitest';
import { buildGraphMiddleware, TimeoutHandler } from './graph-http';
import {
  GRAPH_CALL_TIMEOUT_MS,
  GRAPH_TASK,
  GRAPH_TASK_MAX_CALLS,
  LEASE_MARGIN_MS,
  graphLeaseMs,
} from './graph-task';

const auth = { getAccessToken: () => Promise.resolve('test-token') };

let server: Server | undefined;
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  server = undefined;
});

async function serve(
  handler: (req: IncomingMessage, res: import('node:http').ServerResponse, hit: number) => void,
) {
  let hits = 0;
  server = createServer((req, res) => handler(req, res, ++hits));
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, hits: () => hits };
}

const clientFor = (baseUrl: string, timeoutMs?: number) =>
  Client.initWithMiddleware({ middleware: buildGraphMiddleware(auth, timeoutMs), baseUrl });

describe('the Graph middleware chain', () => {
  it('has no RetryHandler and does have a TimeoutHandler', () => {
    const chain = buildGraphMiddleware(auth);
    expect(chain.some((m) => m instanceof RetryHandler)).toBe(false);
    expect(chain.some((m) => m instanceof TimeoutHandler)).toBe(true);
  });

  it.each([429, 503, 504])(
    'makes exactly ONE request when the server answers %i with Retry-After',
    async (status) => {
      const { baseUrl, hits } = await serve((_req, res) => {
        res.writeHead(status, { 'retry-after': '1', 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'TooManyRequests', message: 'slow down' } }));
      });

      const err: unknown = await clientFor(baseUrl)
        .api('/users/x')
        .patch({ accountEnabled: true })
        .catch((e: unknown) => e);

      // Left to the relay to classify and schedule; nothing was retried inside the call.
      expect(hits()).toBe(1);
      expect((err as { statusCode?: number }).statusCode).toBe(status);
    },
  );

  it('gives up on a server that never answers, at the deadline', async () => {
    const { baseUrl } = await serve(() => {
      /* never respond */
    });
    const started = Date.now();

    await expect(clientFor(baseUrl, 150).api('/users/x').get()).rejects.toBeDefined();

    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('gives up on a body that stalls after the headers, too (the deadline covers reading it)', async () => {
    const { baseUrl } = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"value":[');
      /* never finish */
    });
    const started = Date.now();

    await expect(clientFor(baseUrl, 150).api('/users').get()).rejects.toBeDefined();

    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('works for an ordinary request', async () => {
    // (The SDK sends the token only over https to a Graph host, so a local http server sees none; what
    // this proves is that the chain, including the timeout hop, passes an ordinary request through.)
    const { baseUrl } = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"id":"u1"}');
    });

    expect(await clientFor(baseUrl).api('/users/u1').get()).toEqual({ id: 'u1' });
  });
});

describe('leases outlive their calls', () => {
  const kinds = Object.values(GRAPH_TASK);

  it.each(kinds)('%s: lease > maxCalls x per-call timeout + margin', (kind) => {
    const calls = GRAPH_TASK_MAX_CALLS[kind];
    const worstCase = calls * GRAPH_CALL_TIMEOUT_MS;

    expect(graphLeaseMs(kind)).toBeGreaterThanOrEqual(worstCase + LEASE_MARGIN_MS);
    expect(graphLeaseMs(kind)).toBeGreaterThan(worstCase);
  });

  it('every kind has a declared call budget (a new kind cannot ship without one)', () => {
    expect(Object.keys(GRAPH_TASK_MAX_CALLS).sort()).toEqual([...kinds].sort());
  });

  it('the margin is not a rounding error', () => {
    expect(LEASE_MARGIN_MS).toBeGreaterThanOrEqual(GRAPH_CALL_TIMEOUT_MS);
  });
});
