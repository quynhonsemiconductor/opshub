/**
 * Unit tests — DoorAlertsService. The outbox unique index is on the idempotency key alone, so the
 * per-recipient suffix is what lets every door.manage holder receive the same alert.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DoorAlertsService } from './door-alerts.service';

describe('DoorAlertsService.send', () => {
  const scheduler = { schedule: vi.fn().mockResolvedValue(undefined) };
  const db = {};
  let service: DoorAlertsService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new DoorAlertsService(db as never, scheduler as never);
  });

  it('schedules one row per recipient with a distinct key ending in the recipient id', async () => {
    await service.send(
      'hr-1',
      'door.terminal_offline',
      { active: 2, seen: 1, windowMinutes: 150 },
      'door.terminal_offline:2026-10-26',
    );
    await service.send(
      'it-1',
      'door.terminal_offline',
      { active: 2, seen: 1, windowMinutes: 150 },
      'door.terminal_offline:2026-10-26',
    );

    expect(scheduler.schedule).toHaveBeenCalledTimes(2);
    const keys = scheduler.schedule.mock.calls.map(
      (c) => (c[1] as { idempotencyKey: string }).idempotencyKey,
    );
    expect(keys).toEqual([
      'door.terminal_offline:2026-10-26:hr-1',
      'door.terminal_offline:2026-10-26:it-1',
    ]);
    expect(new Set(keys).size).toBe(2);
    expect(scheduler.schedule.mock.calls[0][1]).toMatchObject({
      type: 'door.terminal_offline',
      recipientId: 'hr-1',
    });
  });

  it('keeps the same key for a resend to the same recipient (dedupe by the outbox)', async () => {
    await service.send(
      'hr-1',
      'door.low_battery',
      { terminalName: 'Main', batteryMv: 4900, thresholdMv: 5000 },
      'door.low_battery:term-1:2026-10-26',
      'term-1',
    );
    await service.send(
      'hr-1',
      'door.low_battery',
      { terminalName: 'Main', batteryMv: 4900, thresholdMv: 5000 },
      'door.low_battery:term-1:2026-10-26',
      'term-1',
    );
    const keys = scheduler.schedule.mock.calls.map(
      (c) => (c[1] as { idempotencyKey: string }).idempotencyKey,
    );
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toBe('door.low_battery:term-1:2026-10-26:hr-1');
  });
});
