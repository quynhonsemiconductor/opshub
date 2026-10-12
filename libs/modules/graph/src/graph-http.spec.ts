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
import {
  Client,
  HTTPMessageHandler,
  RetryHandler,
  type Context,
  type Middleware,
} from '@microsoft/microsoft-graph-client';
import { afterEach, describe, expect, it } from 'vitest';
import { buildGraphMiddleware, GraphDeadlineError, TimeoutHandler } from './graph-http';
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
  it('has no RetryHandler, and the TimeoutHandler comes FIRST so its deadline covers the token', () => {
    const chain = buildGraphMiddleware(auth);
    expect(chain.some((m) => m instanceof RetryHandler)).toBe(false);
    expect(chain[0]).toBeInstanceOf(TimeoutHandler);
    expect(chain.at(-1)).toBeInstanceOf(HTTPMessageHandler);
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

/**
 * A stand-in for AuthenticationHandler whose token takes as long as the test says. (The real handler
 * attaches a token only to https Graph hosts, so it cannot be driven against a local server; what matters
 * here is its position in the chain and that it awaits something that ignores an AbortSignal.)
 */
class StallingAuth implements Middleware {
  next: Middleware | undefined;
  private release!: () => void;
  readonly gate = new Promise<void>((resolve) => (this.release = resolve));
  setNext(next: Middleware): void {
    this.next = next;
  }
  async execute(context: Context): Promise<void> {
    await this.gate; // getAccessToken(): MSAL, no timeout, its own retries
    await this.next!.execute(context);
  }
  tokenArrives(): void {
    this.release();
  }
}

describe('a token acquisition that stalls is inside the deadline', () => {
  function stalledClient(baseUrl: string, timeoutMs: number) {
    const auth = new StallingAuth();
    const chain: Middleware[] = [new TimeoutHandler(timeoutMs), auth, new HTTPMessageHandler()];
    chain[0].setNext!(chain[1]);
    chain[1].setNext!(chain[2]);
    return { auth, client: Client.initWithMiddleware({ middleware: chain, baseUrl }) };
  }

  it('REJECTS at the deadline even though the token never arrives', async () => {
    const { baseUrl } = await serve((_req, res) => res.end('{}'));
    const { client } = stalledClient(baseUrl, 150);
    const started = Date.now();

    const err: unknown = await client
      .api('/users/x')
      .patch({ accountEnabled: true })
      .catch((e: unknown) => e);

    expect(Date.now() - started).toBeLessThan(3_000);
    expect(String((err as Error).message)).toMatch(/deadline/);
    expect(GraphDeadlineError).toBeDefined();
  });

  it('NEVER SENDS the request when the token finally arrives after the deadline (no stale PATCH)', async () => {
    /*
     * The race: the token stalls past the lease, another worker acts on newer state, then the token
     * arrives and the first worker's PATCH lands on top. The request must not go out at all.
     */
    const { baseUrl, hits } = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    const { client, auth } = stalledClient(baseUrl, 100);

    await client
      .api('/users/x')
      .patch({ accountEnabled: true })
      .catch(() => undefined);
    auth.tokenArrives(); // too late
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(hits(), 'a request was sent after the deadline').toBe(0);
  });

  it('does not leave an unhandled rejection behind when the late token path then fails', async () => {
    const { baseUrl } = await serve((_req, res) => res.end('{}'));
    const { client, auth } = stalledClient(baseUrl, 80);
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', listener);
    try {
      await client
        .api('/users/x')
        .get()
        .catch(() => undefined);
      auth.tokenArrives();
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      process.off('unhandledRejection', listener);
    }
    expect(unhandled).toEqual([]);
  });
});
