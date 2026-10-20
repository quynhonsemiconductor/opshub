/**
 * OutboxWakeListener without a database: a fake pg client that can be made to drop or refuse. The real NOTIFY path (after
 * commit, rollback, a dropped backend, a missed notify) is in test/e2e/outbox-wake.e2e.spec.ts.
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OUTBOX_WAKE_APPLICATION_NAME,
  OutboxWakeListener,
  relaysWokenBy,
  type OutboxWakeListenerOptions,
} from './outbox-wake';

class FakeClient extends EventEmitter {
  static created: FakeClient[] = [];
  static queries: string[] = [];
  /** How many of the next connect() calls fail. */
  static failConnects = 0;
  /** How the watchdog's SELECT 1 behaves: it answers, hangs, or fails. */
  static watchdog: 'ok' | 'hang' | 'fail' = 'ok';

  readonly config: { application_name?: string; keepAlive?: boolean };

  constructor(config: { application_name?: string; keepAlive?: boolean }) {
    super();
    this.config = config;
    FakeClient.created.push(this);
  }

  connect(): Promise<void> {
    if (FakeClient.failConnects > 0) {
      FakeClient.failConnects -= 1;
      return Promise.reject(new Error('connect ECONNREFUSED'));
    }
    return Promise.resolve();
  }

  query(text: string): Promise<unknown> {
    FakeClient.queries.push(text);
    if (text === 'SELECT 1') {
      if (FakeClient.watchdog === 'hang') return new Promise(() => undefined);
      if (FakeClient.watchdog === 'fail') return Promise.reject(new Error('socket closed'));
    }
    return Promise.resolve({});
  }

  end(): Promise<void> {
    this.emit('end');
    return Promise.resolve();
  }
}

const logger = () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() });

function listener(
  opts: Omit<OutboxWakeListenerOptions, 'config' | 'logger' | 'createClient'> = {},
) {
  const log = logger();
  const l = new OutboxWakeListener({
    config: { connectionString: 'postgres://unused' },
    logger: log,
    createClient: (config) => new FakeClient(config) as never,
    ...opts,
  });
  return { listener: l, log };
}

const current = (): FakeClient => FakeClient.created[FakeClient.created.length - 1];

beforeEach(() => {
  FakeClient.created = [];
  FakeClient.queries = [];
  FakeClient.failConnects = 0;
  FakeClient.watchdog = 'ok';
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('OutboxWakeListener', () => {
  it('LISTENs on the outbox channel under its own application name', async () => {
    const { listener: l } = listener();
    await l.start();
    expect(FakeClient.queries).toEqual(['LISTEN outbox']);
    expect(current().config.application_name).toBe(OUTBOX_WAKE_APPLICATION_NAME);
    expect(current().config.keepAlive).toBe(true);
    expect(l.listening).toBe(true);
    await l.stop();
  });

  it('calls each handler with the payload (the outbox kind) and ignores other channels', async () => {
    const { listener: l } = listener();
    await l.start();
    const first = vi.fn();
    const second = vi.fn();
    l.onWake(first);
    l.onWake(second);

    current().emit('notification', { channel: 'outbox', payload: 'email' });
    current().emit('notification', { channel: 'some-other-channel', payload: 'graph' });

    expect(first).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledWith('email');
    expect(second).toHaveBeenCalledWith('email');
    await l.stop();
  });

  it('a handler that throws is logged, and the other handlers still run', async () => {
    const { listener: l, log } = listener();
    await l.start();
    const survivor = vi.fn();
    l.onWake(() => {
      throw new Error('relay exploded');
    });
    l.onWake(survivor);

    current().emit('notification', { channel: 'outbox', payload: 'webhook' });

    expect(survivor).toHaveBeenCalledWith('webhook');
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('relay exploded'));
    await l.stop();
  });

  it('a dropped connection is rebuilt after the backoff', async () => {
    const { listener: l } = listener({ minBackoffMs: 1000, maxBackoffMs: 30_000 });
    await l.start();

    current().emit('error', new Error('terminating connection due to administrator command'));
    expect(l.listening).toBe(false);
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeClient.created).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeClient.created).toHaveLength(2);
    expect(l.listening).toBe(true);
    await l.stop();
  });

  it('the backoff doubles while attempts keep failing, and resets once one LISTENs', async () => {
    const { listener: l } = listener({ minBackoffMs: 1000, maxBackoffMs: 30_000 });
    await l.start();
    current().emit('error', new Error('drop')); // wait 1000 ms

    FakeClient.failConnects = 1;
    await vi.advanceTimersByTimeAsync(1000); // attempt 2 is refused: wait 2000 ms
    expect(FakeClient.created).toHaveLength(2);
    expect(l.listening).toBe(false);
    await vi.advanceTimersByTimeAsync(1999);
    expect(FakeClient.created).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1); // attempt 3 LISTENs
    expect(FakeClient.created).toHaveLength(3);
    expect(l.listening).toBe(true);

    // LISTEN succeeded, so the next loss waits the minimum again.
    current().emit('error', new Error('drop again'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeClient.created).toHaveLength(4);
    expect(l.listening).toBe(true);
    await l.stop();
  });

  it('keeps retrying when the first connects are refused, and LISTENs once the database answers', async () => {
    const { listener: l } = listener({ minBackoffMs: 1000 });
    FakeClient.failConnects = 2;
    await l.start();
    expect(l.listening).toBe(false);

    await vi.advanceTimersByTimeAsync(1000);
    expect(l.listening).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(l.listening).toBe(true);
    expect(FakeClient.queries).toEqual(['LISTEN outbox']);
    await l.stop();
  });

  it('one loss that fires both error and end schedules ONE reconnect', async () => {
    const { listener: l } = listener({ minBackoffMs: 1000 });
    await l.start();

    current().emit('error', new Error('drop'));
    current().emit('end');
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(FakeClient.created).toHaveLength(2);
    await l.stop();
  });

  it('probes the LISTEN connection with SELECT 1 on an interval, and keeps it while it answers', async () => {
    const { listener: l } = listener({ watchdogIntervalMs: 30_000, watchdogTimeoutMs: 5_000 });
    await l.start();
    await vi.advanceTimersByTimeAsync(90_000);

    expect(FakeClient.queries.filter((q) => q === 'SELECT 1')).toHaveLength(3);
    expect(FakeClient.created).toHaveLength(1);
    expect(l.listening).toBe(true);
    await l.stop();
  });

  it('a probe that does not answer in time drops the connection and reconnects', async () => {
    const { listener: l } = listener({
      minBackoffMs: 1000,
      watchdogIntervalMs: 30_000,
      watchdogTimeoutMs: 5_000,
    });
    await l.start();
    FakeClient.watchdog = 'hang';

    await vi.advanceTimersByTimeAsync(30_000); // the probe starts and never answers
    await vi.advanceTimersByTimeAsync(4_999);
    expect(l.listening).toBe(true);
    await vi.advanceTimersByTimeAsync(1); // 5 s on: judged dead
    expect(l.listening).toBe(false);

    FakeClient.watchdog = 'ok';
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeClient.created).toHaveLength(2);
    expect(l.listening).toBe(true);
    await l.stop();
  });

  it('a probe that fails drops the connection at once and reconnects', async () => {
    const { listener: l } = listener({ minBackoffMs: 1000, watchdogIntervalMs: 30_000 });
    await l.start();
    FakeClient.watchdog = 'fail';

    await vi.advanceTimersByTimeAsync(30_000);
    expect(l.listening).toBe(false);

    FakeClient.watchdog = 'ok';
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeClient.created).toHaveLength(2);
    expect(l.listening).toBe(true);
    await l.stop();
  });

  it('refuses a watchdog timeout that is not shorter than its interval', () => {
    expect(() => listener({ watchdogIntervalMs: 5_000, watchdogTimeoutMs: 5_000 })).toThrow(
      /must be shorter than its interval/,
    );
  });

  it('stop() ends the connection and cancels a pending reconnect', async () => {
    const { listener: l } = listener({ minBackoffMs: 1000 });
    await l.start();
    current().emit('error', new Error('drop'));

    await l.stop();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(FakeClient.created).toHaveLength(1);
    expect(l.listening).toBe(false);
  });
});

describe('relaysWokenBy', () => {
  it('wakes only the relays whose wakeKind is the notified kind', () => {
    const email = { wakeKind: 'email' as string | undefined };
    const graphScan = { wakeKind: 'graph-scan' as string | undefined };
    const polledOnly = { wakeKind: undefined as string | undefined };
    const relays = [email, graphScan, polledOnly];

    expect(relaysWokenBy('email', relays)).toEqual([email]);
    expect(relaysWokenBy('graph-scan', relays)).toEqual([graphScan]);
    expect(relaysWokenBy('unknown', relays)).toEqual([]);
  });
});
