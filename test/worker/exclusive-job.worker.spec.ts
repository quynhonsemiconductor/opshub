/**
 * ExclusiveJob, ticked for real: the worker's own module, its own CacheService, a real Valkey.
 *
 * Every job that goes through ExclusiveJob (seven crons, the Graph syncs and the Graph task relays) calls `CacheService.tryLock`. platform-runtime 0.2.0 needs it
 * from platform-cache 3.2.0; this product resolved 3.1.x, where it does not exist, and every tick failed in develop with "this.cache.tryLock is not
 * a function" while every test passed: the unit tests mock ExclusiveJob, so nothing ran a tick against the cache the worker actually has.
 *
 * Runs in the worker's own vitest project (`pnpm test:logging-worker`, environment: test/logging/worker-env.fixture.ts): the worker's env schema
 * refuses the API-only variables the e2e config sets.
 *
 * Asserts the behaviour a pod relies on: the job runs, the lock is released afterwards (the next tick runs), and while one pod holds it
 * another pod's tick is skipped rather than run twice.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CacheService } from '@quynhonsemiconductor/platform-cache';
import { ExclusiveJob } from '@quynhonsemiconductor/platform-runtime';
import { prepareWorkerApp } from '@quynhonsemiconductor/platform-runtime/bootstrap';
import type { INestApplicationContext } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';

let app: INestApplicationContext;
let exclusive: ExclusiveJob;
let cache: CacheService;

beforeAll(async () => {
  app = await prepareWorkerApp({
    before: async () => {
      await import('../../apps/worker/src/role');
    },
    module: () => import('../../apps/worker/src/worker.module').then((m) => m.WorkerModule),
    // The fixture's environment (a minimal worker one); only the log level is lowered for this spec.
    env: { ...process.env, LOG_LEVEL: 'fatal' },
    otel: { serviceNameEnvVar: 'OTEL_WORKER_SERVICE_NAME', defaultServiceName: 'opshub-worker' },
  });
  // Booting the worker module also starts its schedules (the relays tick every 5-10 s) against the shared e2e database and Valkey. This spec
  // drives ExclusiveJob by hand; stop every cron, interval and timeout the module registered so it does not process rows other specs own.
  const registry = app.get(SchedulerRegistry, { strict: false });
  for (const job of registry.getCronJobs().values()) void job.stop();
  for (const name of registry.getIntervals()) registry.deleteInterval(name);
  for (const name of registry.getTimeouts()) registry.deleteTimeout(name);
  exclusive = app.get(ExclusiveJob, { strict: false });
  cache = app.get(CacheService, { strict: false });
  // The cache connects in the background (onModuleInit does not wait for `ready`); a tick a few seconds after boot sees it connected.
  for (let waited = 0; !cache.isAvailable && waited < 10_000; waited += 100) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}, 60_000);

afterAll(async () => {
  await app?.close();
});

const name = (): string => `e2e-exclusive-${Math.random().toString(36).slice(2)}`;

describe('ExclusiveJob against the worker’s real cache', () => {
  it('the cache is a real Valkey and has tryLock', () => {
    expect(cache.isAvailable, 'no Valkey: the lock path would not be exercised').toBe(true);
    expect(typeof cache.tryLock).toBe('function');
  });

  it('runs the job, releases the lock, and runs again on the next tick', async () => {
    const job = name();
    const runs: number[] = [];
    await exclusive.run(job, 5_000, () => Promise.resolve(void runs.push(1)));
    await exclusive.run(job, 5_000, () => Promise.resolve(void runs.push(2)));
    expect(runs).toEqual([1, 2]);
  });

  it('skips the tick of ANOTHER pod while one holds the lock (never runs it twice)', async () => {
    const job = name();
    // A second ExclusiveJob over the same cache stands in for a second pod: the in-process `running` guard is per instance.
    const otherPod = new ExclusiveJob(cache, undefined);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const first = exclusive.run(job, 10_000, async () => {
      started();
      await held;
    });
    try {
      await running;

      let ranOnOtherPod = false;
      await otherPod.run(job, 10_000, () => Promise.resolve(void (ranOnOtherPod = true)));
      expect(ranOnOtherPod, 'two pods ran the same exclusive job at once').toBe(false);

      release();
      await first;
      await otherPod.run(job, 10_000, () => Promise.resolve(void (ranOnOtherPod = true)));
      expect(ranOnOtherPod, 'the lock was not released when the first run finished').toBe(true);
    } finally {
      // An assertion that fails above must not leave the lock held (it would stay until its TTL) or the first run hanging.
      release();
      await first.catch(() => undefined);
    }
  });

  it('propagates a failing job (so the failure metric counts it) and still releases the lock', async () => {
    const job = name();
    await expect(
      exclusive.run(job, 5_000, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    let ran = false;
    await exclusive.run(job, 5_000, () => Promise.resolve(void (ran = true)));
    expect(ran).toBe(true);
  });
});
