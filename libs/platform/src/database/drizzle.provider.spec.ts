/**
 * The pool must not be cold when the process starts accepting traffic.
 *
 * `pg-pool` does not pre-create connections from `min`. Verified against the pinned
 * dependency, not the types: in pg-pool 3.14.0 `min` is read in exactly one place,
 * `_isAboveMin()`, whose only callers decide whether an ALREADY OPEN idle client may be
 * reaped. `@types/pg` types the option, so nothing complained, and a fresh task's pool
 * therefore held zero clients while the ALB — which health-checks the dependency-free
 * `/v1/healthz` — had already admitted it to live traffic. The first request paid TCP +
 * TLS + SCRAM, and on a low-traffic environment that single request is the p99.
 *
 * These tests pin the four properties the fix depends on, each of which can regress
 * silently:
 *   - the warm-up happens, and opens as many connections as `DATABASE_POOL_MIN` asks for;
 *   - the connections are acquired CONCURRENTLY — a sequential connect/release loop hands
 *     back the same idle client every iteration and ends with a pool of one while looking
 *     like it worked, which is the failure mode a plain call-count assertion misses;
 *   - a warm-up failure does not crash boot, because warm-up is an optimisation over the
 *     previous behaviour and a cold pool is exactly what production ran with before;
 *   - `min` is still handed to the pool, since it does govern idle reaping and dropping it
 *     would let `idleTimeoutMillis` reap the warmed pool straight back to zero.
 *
 * The pool is replaced with a stub rather than mocking the `pg` module: the narrowest seam
 * that keeps the provider's own lifecycle code under test, and the same approach the
 * neighbouring provider specs take.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../config/env.schema';
import { AppConfigService } from '../config/app-config.service';
import { DrizzleProvider } from './drizzle.provider';

/** A typed AppConfigService stand-in — only the keys this provider reads need values. */
function makeConfig(overrides: Partial<Env> = {}): AppConfigService {
  const values: Partial<Env> = {
    DATABASE_URL: 'postgresql://test:test@localhost:5432/opshub_test',
    DATABASE_SSLMODE: 'disable',
    DATABASE_POOL_MIN: 3,
    DATABASE_POOL_MAX: 20,
    LOG_SQL: false,
    ...overrides,
  };
  return {
    get: <K extends keyof Env>(key: K): Env[K] => values[key] as Env[K],
  } as AppConfigService;
}

/** Reach the private pool without mocking the module that creates it. */
function poolOf(provider: DrizzleProvider): { options: Record<string, unknown> } {
  return (provider as unknown as { pool: { options: Record<string, unknown> } }).pool;
}

/**
 * Swap in a pool whose `connect()` resolves only when the returned `settle` is called, so a
 * test can observe how many connections were in flight at once.
 */
function stubPool(provider: DrizzleProvider) {
  const events: string[] = [];
  const pending: Array<(client: { release: () => void }) => void> = [];
  const connect = vi.fn(
    () =>
      new Promise<{ release: () => void }>((resolve) => {
        events.push('connect');
        pending.push(resolve);
      }),
  );
  const stub = {
    connect,
    end: vi.fn().mockResolvedValue(undefined),
  };
  (provider as unknown as { pool: typeof stub }).pool = stub;
  return {
    connect,
    events,
    inFlight: () => pending.length,
    settleAll: () => {
      for (const resolve of pending.splice(0)) {
        resolve({
          release: () => {
            events.push('release');
          },
        });
      }
    },
  };
}

describe('DrizzleProvider pool warm-up', () => {
  it('still passes min to the pool, because it governs idle reaping', () => {
    const provider = new DrizzleProvider(makeConfig({ DATABASE_POOL_MIN: 4 }));

    // Not pre-creation — that is what onModuleInit is for — but the floor that stops
    // idleTimeoutMillis reaping the warmed connections back to zero between requests.
    expect(poolOf(provider).options['min']).toBe(4);
    expect(poolOf(provider).options['max']).toBe(20);
  });

  it('opens DATABASE_POOL_MIN connections and releases every one of them', async () => {
    const provider = new DrizzleProvider(makeConfig({ DATABASE_POOL_MIN: 3 }));
    const pool = stubPool(provider);

    const warming = provider.onModuleInit();
    await Promise.resolve();
    pool.settleAll();
    await warming;

    expect(pool.connect).toHaveBeenCalledTimes(3);
    // Every acquired client is returned to the pool as idle; leaking them would starve
    // the pool of the very capacity the warm-up just created.
    expect(pool.events.filter((e) => e === 'release')).toHaveLength(3);
  });

  it('acquires the connections concurrently, not one at a time', async () => {
    const provider = new DrizzleProvider(makeConfig({ DATABASE_POOL_MIN: 3 }));
    const pool = stubPool(provider);

    const warming = provider.onModuleInit();
    await Promise.resolve();

    // THE REGRESSION THIS GUARDS. All three acquisitions are outstanding before any is
    // released. A sequential loop would show one in flight here, would still record three
    // `connect` calls overall, and would leave the pool holding a single connection.
    expect(pool.inFlight()).toBe(3);
    expect(pool.events).toEqual(['connect', 'connect', 'connect']);

    pool.settleAll();
    await warming;
  });

  it('clamps the warm-up to DATABASE_POOL_MAX when the two bounds disagree', async () => {
    // The env schema validates both bounds as positive ints INDEPENDENTLY — neither is
    // checked against the other — so MIN > MAX is representable. Unclamped, the surplus
    // connect() calls would queue behind an exhausted pool and resolve only by hitting
    // connectionTimeoutMillis, turning a typo into seconds of silent boot delay.
    const provider = new DrizzleProvider(
      makeConfig({ DATABASE_POOL_MIN: 10, DATABASE_POOL_MAX: 2 }),
    );
    const pool = stubPool(provider);

    const warming = provider.onModuleInit();
    await Promise.resolve();
    pool.settleAll();
    await warming;

    expect(pool.connect).toHaveBeenCalledTimes(2);
  });

  it('logs and continues when warm-up fails, rather than crashing boot', async () => {
    const provider = new DrizzleProvider(makeConfig({ DATABASE_POOL_MIN: 2 }));
    const connect = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    (provider as unknown as { pool: { connect: typeof connect } }).pool = { connect };
    const warn = vi
      .spyOn((provider as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn')
      .mockImplementation(() => undefined);

    // Must not reject: Nest awaits onModuleInit inside app.listen(), so a throw here is a
    // boot failure. A database that is unreachable will fail the first request anyway; the
    // difference is that a slow-but-up task can still serve and a crash-looping one cannot.
    await expect(provider.onModuleInit()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('ECONNREFUSED');
  });

  it('does nothing when the configured floor is zero', async () => {
    const provider = new DrizzleProvider(makeConfig({ DATABASE_POOL_MIN: 0 }));
    const pool = stubPool(provider);

    await provider.onModuleInit();

    expect(pool.connect).not.toHaveBeenCalled();
  });
});
