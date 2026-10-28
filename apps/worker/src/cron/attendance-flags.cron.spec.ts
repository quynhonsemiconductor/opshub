/**
 * Unit tests — the morning attendance sweep's cron: one notification per flagged person, keyed so a
 * re-run cannot double-notify, a failure for one person does not stop the rest, and nothing is sent
 * on a day with no flags.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AttendanceFlagsCron } from './attendance-flags.cron';

const tx = { tag: 'tx' };
const db = { transaction: vi.fn((cb: (t: unknown) => unknown) => cb(tx)) };
const attendance = { previousWorkingDay: vi.fn(), unresolvedFlagsFor: vi.fn() };
const notifScheduler = { schedule: vi.fn() };
const exclusive = {
  run: vi.fn((_name: string, _ttl: number, fn: () => Promise<void>) => fn()),
};

function cron(): AttendanceFlagsCron {
  return new AttendanceFlagsCron(
    db as never,
    attendance as never,
    notifScheduler as never,
    exclusive as never,
  );
}

describe('AttendanceFlagsCron.tick', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    attendance.previousWorkingDay.mockResolvedValue('2026-10-23');
    notifScheduler.schedule.mockResolvedValue(undefined);
  });

  it('runs under the exclusive lock, so a second replica does not repeat the sweep', async () => {
    attendance.unresolvedFlagsFor.mockResolvedValue([]);
    await cron().tick();
    expect(exclusive.run).toHaveBeenCalledWith(
      'attendance-flags',
      expect.any(Number),
      expect.any(Function),
    );
  });

  it('sweeps the PREVIOUS WORKING day and sends nothing when no one is flagged', async () => {
    attendance.unresolvedFlagsFor.mockResolvedValue([]);
    await cron().tick();
    expect(attendance.unresolvedFlagsFor).toHaveBeenCalledWith('2026-10-23');
    expect(notifScheduler.schedule).not.toHaveBeenCalled();
  });

  it('notifies each flagged person once, with a per-person-per-day idempotency key', async () => {
    attendance.unresolvedFlagsFor.mockResolvedValue([
      { employeeId: 'e1', name: 'An', flags: ['late'] },
      { employeeId: 'e2', name: 'Binh', flags: ['missing_checkout'] },
    ]);
    await cron().tick();
    expect(notifScheduler.schedule).toHaveBeenCalledTimes(2);
    expect(notifScheduler.schedule).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        type: 'attendance.flags_unresolved',
        recipientId: 'e1',
        idempotencyKey: 'attendance_flags:2026-10-23:e1',
        vars: { date: '2026-10-23', flags: ['late'] },
      }),
    );
    expect(notifScheduler.schedule).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ idempotencyKey: 'attendance_flags:2026-10-23:e2' }),
    );
  });

  it('one failed notification is logged and skipped; the rest still go out', async () => {
    attendance.unresolvedFlagsFor.mockResolvedValue([
      { employeeId: 'e1', name: 'An', flags: ['late'] },
      { employeeId: 'e2', name: 'Binh', flags: ['late'] },
    ]);
    notifScheduler.schedule.mockRejectedValueOnce(new Error('boom'));
    await expect(cron().tick()).resolves.toBeUndefined();
    expect(notifScheduler.schedule).toHaveBeenCalledTimes(2);
  });
});
