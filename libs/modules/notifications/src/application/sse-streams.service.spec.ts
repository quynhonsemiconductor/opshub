import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { SseStreams } from './sse-streams.service';

function stream(
  writable = true,
): ServerResponse & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> } {
  return Object.assign(new EventEmitter(), { writable, write: vi.fn(), end: vi.fn() }) as never;
}

describe('SseStreams', () => {
  it('registers a preClose hook that ends every open stream with a reconnect event', async () => {
    const hooks: Record<string, () => Promise<void>> = {};
    const addHook = vi.fn((name: string, fn: () => Promise<void>) => (hooks[name] = fn));
    const streams = new SseStreams({ httpAdapter: { getInstance: () => ({ addHook }) } } as never);
    streams.onModuleInit();
    const a = stream();
    const b = stream();
    streams.register(a);
    streams.register(b);

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
    streams.register(gone);
    streams.register(dead);
    gone.emit('close');

    streams.endAll();

    expect(gone.end).not.toHaveBeenCalled();
    expect(dead.write).not.toHaveBeenCalled();
    expect(dead.end).not.toHaveBeenCalled();
  });

  it('does nothing without a Fastify adapter (the worker serves no HTTP)', () => {
    expect(() => new SseStreams({ httpAdapter: undefined } as never).onModuleInit()).not.toThrow();
  });
});
