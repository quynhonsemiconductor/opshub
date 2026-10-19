import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { SseStreams } from './sse-streams.service';

// The mocks come back as locals, so the assertions never read a method off the response
// object (unbound-method): the response is what the service holds, the mocks are what we check.
function stream(writable = true) {
  const write = vi.fn();
  const end = vi.fn();
  const res = Object.assign(new EventEmitter(), {
    writable,
    write,
    end,
  }) as unknown as ServerResponse;
  return { res, write, end };
}

describe('SseStreams', () => {
  it('registers a preClose hook that ends every open stream with a reconnect event', async () => {
    const hooks: Record<string, () => Promise<void>> = {};
    const addHook = vi.fn((name: string, fn: () => Promise<void>) => (hooks[name] = fn));
    const streams = new SseStreams({ httpAdapter: { getInstance: () => ({ addHook }) } } as never);
    streams.onModuleInit();
    const a = stream();
    const b = stream();
    streams.register(a.res);
    streams.register(b.res);

    await hooks['preClose']();

    for (const s of [a, b]) {
      expect(s.write).toHaveBeenCalledWith('event: reconnect\ndata: {}\n\n');
      expect(s.end).toHaveBeenCalledTimes(1);
    }
  });

  it('forgets a stream that closed, and skips one that is no longer writable', () => {
    const streams = new SseStreams({} as never);
    const gone = stream();
    const dead = stream(false);
    streams.register(gone.res);
    streams.register(dead.res);
    gone.res.emit('close');

    streams.endAll();

    expect(gone.end).not.toHaveBeenCalled();
    expect(dead.write).not.toHaveBeenCalled();
    expect(dead.end).not.toHaveBeenCalled();
  });

  it('does nothing without a Fastify adapter (the worker serves no HTTP)', () => {
    expect(() => new SseStreams({ httpAdapter: undefined } as never).onModuleInit()).not.toThrow();
  });
});
