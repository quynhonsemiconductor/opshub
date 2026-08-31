/**
 * The `interactive` preset is the only bound on a dependency call a user is waiting for,
 * and both halves of it are easy to break silently.
 *
 * `maxAttempts` is RETRIES, not total calls, so `maxAttempts: 1` must invoke twice — an
 * off-by-one here doubles the budget the preset exists to cap, and nothing about the
 * number 1 says which reading is right.
 *
 * `TimeoutStrategy.Aggressive` is what makes the 3 s ceiling real. The cooperative path
 * aborts a derived signal and then awaits `fn` anyway, relying on `fn` to observe it —
 * and `execute()` takes a zero-argument thunk, so no signal is ever delivered anywhere it
 * could be honoured. Under `Cooperative` the deadline therefore has no effect at all,
 * which the third case pins against `external` so that the difference is asserted rather
 * than described in a comment. If someone "aligns" `interactive` onto `Cooperative` for
 * consistency, that case stays green and the first two start failing, which is the right
 * way round: the failure names the preset that lost its bound.
 *
 * Timers are faked because the real budget is ~6.2 s and a suite must not wait it out.
 * `advanceTimersByTimeAsync` is required rather than the synchronous form — the policy
 * awaits between attempts, so the microtask queue has to drain for the retry to be
 * scheduled at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskCancelledError } from 'cockatiel';
import { ResilienceService } from './resilience.service';

describe('ResilienceService presets', () => {
  let service: ResilienceService;

  beforeEach(() => {
    service = new ResilienceService();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('interactive', () => {
    it('invokes fn twice — maxAttempts is retries, not total calls', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('upstream reset'));

      const settled = expect(
        service.execute('test.interactive.retries', service.interactive, fn),
      ).rejects.toThrow('upstream reset');

      // 200ms of backoff sits between the two attempts; nothing else does.
      await vi.advanceTimersByTimeAsync(1_000);
      await settled;

      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('cancels a call that ignores the deadline, rather than awaiting it', async () => {
      // Deliberately unsettleable and signal-blind: the shape every `execute()` caller
      // has, since the thunk receives no AbortSignal to honour.
      const fn = vi.fn(() => new Promise<string>(() => {}));

      const settled = expect(
        service.execute('test.interactive.deadline', service.interactive, fn),
      ).rejects.toBeInstanceOf(TaskCancelledError);

      // Two 3s attempts plus 200ms of backoff. Advancing past the whole budget proves
      // the rejection comes from the deadline and not from fn settling.
      await vi.advanceTimersByTimeAsync(10_000);
      await settled;

      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe('external', () => {
    it('does NOT bound a signal-blind call — the cooperative timeout is inert here', async () => {
      // 10s ceiling, 20s function. Documents why `interactive` could not simply reuse
      // this preset with a smaller number: the number was never the reason it fails to
      // bound anything for an `execute()` caller.
      const fn = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            setTimeout(() => resolve('late'), 20_000);
          }),
      );

      const settled = service.execute('test.external.inert', service.external, fn);

      await vi.advanceTimersByTimeAsync(25_000);

      await expect(settled).resolves.toBe('late');
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });
});
