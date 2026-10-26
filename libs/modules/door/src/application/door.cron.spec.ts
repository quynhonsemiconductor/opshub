/**
 * Unit tests — the door worker jobs (SA review 480/B2).
 *
 * These crons are registered in DoorJobsModule and fired ONLY by the worker's ScheduleModule. Their
 * whole safety story is in the negatives: no URL configured → no ping; any terminal stale → no
 * ping; ZERO active terminals → no ping (a dead-man's switch that sings when nobody is watching is
 * worse than none); and the retention purges use the two cutoffs, not one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DoorTerminalHealthCron } from './door-terminal-health.cron';
import { DoorEventCleanupService, retentionCutoffs } from './door-event-cleanup.service';

// ── Health cron ───────────────────────────────────────────────────────────────

function makeHealth(over: { url?: string; active?: number; seen?: number } = {}) {
  const ping = vi.fn<(url: string, init?: unknown) => Promise<{ ok: boolean }>>();
  const exclusive = { run: vi.fn((_name: string, _ttl: number, fn: () => Promise<void>) => fn()) };
  const config = {
    get: vi.fn((k: string) => (k === 'DOOR_TERMINAL_HEALTHCHECK_URL' ? over.url : undefined)),
  };
  const terminals = {
    countActive: vi.fn().mockResolvedValue(over.active ?? 1),
    countActiveSeenSince: vi.fn().mockResolvedValue(over.seen ?? 1),
  };
  const cache = { getJson: vi.fn(), setJson: vi.fn() };
  const door = {
    doorManageHolders: vi.fn().mockResolvedValue(['hr-1', 'it-1']),
    scheduleNotification:
      vi.fn<
        (
          recipientId: string,
          input: { type: string; vars: unknown; idempotencyKey: string },
        ) => Promise<void>
      >(),
  };
  const cron = new DoorTerminalHealthCron(
    terminals as never,
    config as never,
    exclusive as never,
    cache as never,
    door as never,
    ping as never,
  );
  return { cron, ping, terminals, cache, door };
}

describe('DoorTerminalHealthCron', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is a NO-OP when DOOR_TERMINAL_HEALTHCHECK_URL is unset (default off)', async () => {
    const { cron, ping } = makeHealth({});
    await cron.tick();
    expect(ping).not.toHaveBeenCalled();
  });

  it('pings when every active terminal was seen within the window', async () => {
    const { cron, ping } = makeHealth({
      url: 'https://hc-ping.example.invalid/ok',
      active: 2,
      seen: 2,
    });
    await cron.tick();
    expect(ping).toHaveBeenCalledWith('https://hc-ping.example.invalid/ok', expect.anything());
  });

  it('withholds the ping when ANY active terminal is stale — the absence IS the alert', async () => {
    const { cron, ping } = makeHealth({
      url: 'https://hc-ping.example.invalid/ok',
      active: 2,
      seen: 1,
    });
    await cron.tick();
    expect(ping).not.toHaveBeenCalled();
  });

  it('notifies door.manage holders ON the transition to stale, once', async () => {
    const { cron, cache, door } = makeHealth({
      url: 'https://hc-ping.example.invalid/ok',
      active: 2,
      seen: 1,
    });
    cache.getJson.mockResolvedValue(null); // fresh marker: not previously stale
    await cron.tick();
    expect(cache.setJson).toHaveBeenCalledWith(
      'door:terminal:offline-alert',
      { stale: true },
      expect.any(Number),
    );
    expect(door.scheduleNotification).toHaveBeenCalledTimes(2); // one per holder
    const first = door.scheduleNotification.mock.calls[0] as [
      string,
      { type: string; vars: unknown; idempotencyKey: string },
    ];
    expect(first[0]).toBe('hr-1');
    expect(first[1].type).toBe('door.terminal_offline');
    expect(first[1].vars).toEqual({ active: 2, seen: 1, windowMinutes: 150 });
    expect(first[1].idempotencyKey).toMatch(/^door\.terminal_offline:\d{4}-\d{2}-\d{2}$/);
  });

  it('does NOT repeat while the marker already says stale', async () => {
    const { cron, cache, door } = makeHealth({
      url: 'https://hc-ping.example.invalid/ok',
      active: 2,
      seen: 1,
    });
    cache.getJson.mockResolvedValue({ stale: true });
    await cron.tick();
    expect(door.scheduleNotification).not.toHaveBeenCalled();
  });

  it('re-arms when all terminals are seen again', async () => {
    const { cron, cache, door } = makeHealth({
      url: 'https://hc-ping.example.invalid/ok',
      active: 2,
      seen: 2,
    });
    cache.getJson.mockResolvedValue({ stale: true });
    await cron.tick();
    expect(cache.setJson).toHaveBeenCalledWith(
      'door:terminal:offline-alert',
      { stale: false },
      expect.any(Number),
    );
    expect(door.scheduleNotification).not.toHaveBeenCalled();
  });

  it('withholds the ping when there are ZERO active terminals', async () => {
    const { cron, ping } = makeHealth({
      url: 'https://hc-ping.example.invalid/ok',
      active: 0,
      seen: 0,
    });
    await cron.tick();
    expect(ping).not.toHaveBeenCalled();
  });
});

// ── Retention ─────────────────────────────────────────────────────────────────

describe('DoorEventCleanupService', () => {
  it('runs the purge through the exclusive lock and reads the retention from config', async () => {
    const run = vi.fn((_n: string, _t: number, fn: () => Promise<void>) => fn());
    // delete() → where() → returning(): the chain the service drives.
    const deleting = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
    });
    const config = { get: vi.fn(() => 730) };
    const service = new DoorEventCleanupService(
      { delete: deleting } as never,
      config as never,
      { run } as never,
    );
    await service.purgeExpiredEvents();
    expect(run).toHaveBeenCalledWith(
      'door-event-cleanup',
      expect.any(Number),
      expect.any(Function),
    );
    expect(config.get).toHaveBeenCalledWith('DOOR_EVENT_RETENTION_DAYS');
    expect(deleting).toHaveBeenCalledTimes(2); // two cutoffs, two deletes
  });

  it('computes TWO cutoffs: unknown cards at the fixed 30 days, attendance at the configured window', () => {
    const now = Date.UTC(2026, 9, 24, 3, 0, 0);
    const { unknownCutoff, attendanceCutoff } = retentionCutoffs(730, now);
    expect(unknownCutoff.getTime()).toBe(now - 30 * 24 * 3600_000);
    expect(attendanceCutoff.getTime()).toBe(now - 730 * 24 * 3600_000);
    // And they are NOT the same clock: attendance reaches ~2 years back.
    expect(attendanceCutoff.getTime()).toBeLessThan(unknownCutoff.getTime() - 300 * 24 * 3600_000);
  });
});
