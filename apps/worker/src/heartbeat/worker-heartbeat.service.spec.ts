import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CacheService } from '@quynhonsemiconductor/platform-cache';
import {
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_HEARTBEAT_KEY_PREFIX,
  WORKER_HEARTBEAT_TTL_SECONDS,
} from './worker-heartbeat.constants';
import { WorkerHeartbeatService } from './worker-heartbeat.service';

describe('WorkerHeartbeatService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function harness(set = vi.fn().mockResolvedValue(undefined)) {
    const cache = { set } as unknown as CacheService;
    return { service: new WorkerHeartbeatService(cache), set };
  }

  it('writes a beat at once, then on every interval, under a key that expires', async () => {
    const { service, set } = harness();
    service.onModuleInit();
    expect(set).toHaveBeenCalledWith(
      service.heartbeatKey,
      '2026-10-19T00:00:00.000Z',
      WORKER_HEARTBEAT_TTL_SECONDS,
    );
    expect(service.heartbeatKey.startsWith(WORKER_HEARTBEAT_KEY_PREFIX)).toBe(true);

    await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_INTERVAL_MS);
    expect(set).toHaveBeenCalledTimes(2);
    service.onModuleDestroy();
  });

  it('stops beating when the module is destroyed', async () => {
    const { service, set } = harness();
    service.onModuleInit();
    service.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_INTERVAL_MS * 3);
    expect(set).toHaveBeenCalledTimes(1);
  });

  it('keeps the worker running when a write fails, and tries again on the next tick', async () => {
    const set = vi
      .fn()
      .mockRejectedValueOnce(new Error('valkey down'))
      .mockResolvedValue(undefined);
    const { service } = harness(set);
    service.onModuleInit();
    await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_INTERVAL_MS);
    expect(set).toHaveBeenCalledTimes(2);
    service.onModuleDestroy();
  });
});
