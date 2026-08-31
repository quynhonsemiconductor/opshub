import { Injectable } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import {
  bulkhead,
  BulkheadRejectedError,
  circuitBreaker,
  ConsecutiveBreaker,
  ExponentialBackoff,
  handleAll,
  type IPolicy,
  retry,
  timeout,
  TimeoutStrategy,
  wrap,
} from 'cockatiel';

// ── OTel metrics instruments (module-scoped singletons) ──────────────────────
const meter = metrics.getMeter('opshub-api');
const callsCounter = meter.createCounter('resilience.calls.total', {
  description: 'Total outcomes of resilience-wrapped calls',
});
const durationHistogram = meter.createHistogram('resilience.calls.duration_ms', {
  description: 'Duration of resilience-wrapped calls',
  unit: 'ms',
  advice: { explicitBucketBoundaries: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000] },
});

/**
 * Pre-configured resilience policies for external and internal calls.
 *
 * Use `resilience.execute(operationName, policy, fn)` to get automatic metrics.
 * Use the bare policy (`.external`, `.database` etc.) when you need more control.
 *
 * Presets:
 *   interactive — 1 retry  + 3s AGGRESSIVE timeout (dependency call a user is waiting on)
 *   external    — 3 retries + 10s timeout  (Graph API, third-party services)
 *   database    — 2 retries + 5s timeout   + circuit-breaker after 5 consecutive failures
 *   cache       — 0 retries + 1s timeout   (fast-fail, not worth retrying)
 *   background  — 5 retries + 30s timeout  (low-urgency async work)
 *
 * READ `maxAttempts` AS "RETRIES", NOT "TOTAL CALLS". This is the one thing about these
 * presets that is easy to get wrong by one, and getting it wrong doubles a budget. In
 * cockatiel 4.0.0 (`dist/RetryPolicy.js:57-64`) the loop invokes `fn`, then retries only
 * `if (!signal.aborted && retries < this.options.maxAttempts)` with `retries` starting at
 * 0 — so total invocations are `maxAttempts + 1`. `external` is therefore FOUR calls of up
 * to 10s each plus exponential backoff (200 + 400 + 800ms), a worst case near 41s, not the
 * 30s a quick reading gives. The preset names below are chosen so the choice is about
 * "who is waiting", which is a question a caller can answer, rather than about arithmetic
 * a caller has to redo.
 *
 * `wrap(retry, timeout)` puts retry OUTSIDE timeout, so each attempt gets its own clock.
 * That is what makes the budget multiplicative and is why a preset's timeout alone never
 * bounds a request.
 */
@Injectable()
export class ResilienceService {
  /**
   * A dependency call made while a user holds an open HTTP request: 1 retry, 3 s ceiling.
   * Worst case 3000 + 200ms backoff + 3000 ≈ 6.2 s.
   *
   * WHY A SEPARATE PRESET RATHER THAN RETUNING `external`. `external` is correct for the
   * caller it was written for — a worker or relay retrying Graph, where nobody is waiting
   * and 41 s of patience is cheaper than a failed job. It is wrong for a caller that is
   * inside a request, and the two cannot be served by one number. Lowering `external`
   * globally would make background work fail on blips it currently rides out; leaving it
   * on the request path leaves a 41 s request that is invisible to the 5xx alert because
   * it does not answer 5xx. Splitting by "who is waiting" is the only division that lets
   * both callers be right.
   *
   * WHY 3 s. The call this exists for is `StorageService.headObject` — one S3 HeadObject
   * round trip, in-region, whose normal cost is tens of milliseconds. 3 s is roughly two
   * orders of magnitude of headroom, so it cannot fire on ordinary variance; what it
   * catches is a connection that is hung rather than slow, which is the failure mode
   * retrying actually helps with.
   *
   * WHY 1 RETRY (two calls total, per the `maxAttempts` note above). One retry covers the
   * case retries are good for on an interactive path — a single reset connection or a
   * transient 5xx from the dependency. A second retry mostly buys latency: by then the
   * dependency is having an outage, not a hiccup, and a user is better served by a fast
   * error than by a third attempt they are waiting through.
   *
   * WHY `Aggressive` AND NOT `Cooperative` — THE PART THAT MAKES THIS A BOUND AT ALL.
   * Every other preset in this file uses `TimeoutStrategy.Cooperative`, and for callers of
   * `execute()` below that setting bounds NOTHING. Cockatiel 4.0.0's cooperative path
   * (`dist/TimeoutPolicy.js`, the `execute` method) aborts a derived signal and then does
   * `return returnOrThrow(await this.executor.invoke(fn, context, aborter.signal))` — it
   * WAITS for `fn` to settle and relies on `fn` observing the signal. `execute()` below
   * takes `fn: () => Promise<T>`, a zero-argument thunk, so the signal is never delivered
   * anywhere it could be honoured and the deadline passes without effect. Verified rather
   * than reasoned about: under a 50 ms cooperative timeout a 400 ms function still resolves
   * with its value. The aggressive path instead races `fn` against the abort and throws
   * `TaskCancelledError`, which is what a caller inside a request needs.
   *
   * The cost of aggressive cancellation is that the abandoned operation keeps running to
   * completion in the background. That is acceptable here and would not be everywhere: the
   * call this bounds is a read-only S3 HeadObject with no side effect, so abandoning it
   * wastes a socket and nothing else. The fuller fix — threading the AbortSignal through
   * `execute()` into `s3.send(cmd, { abortSignal })` so the request is genuinely cancelled —
   * is better, and is deliberately not done here: it changes `execute()`'s signature for
   * every existing caller, and for a HEAD with no side effect it buys only an earlier socket
   * release. The other presets are left on `Cooperative` for the same scoping reason, and
   * that their timeouts are therefore inert is a real finding, not an endorsement.
   *
   * WHAT THIS TRADES. Tightening the budget makes the dependency's failure surface sooner,
   * and on the `confirmUpload` path a HeadObject failure is currently reported to the user
   * as a 400 `FILE_NOT_UPLOADED` — `headObject` swallows every error to `null` and the
   * caller cannot tell "object absent" from "S3 unreachable". That conflation is a real
   * defect, but it is NOT made worse here: a blip long enough to exhaust the old budget
   * produced the same wrong 400, just 41 s later. The only requests whose outcome changes
   * are those that would have recovered between ~6 s and ~41 s, and for those a fast wrong
   * error beats a slow wrong error. Fixing the conflation — re-throwing a transport error
   * as a 503 instead of returning `null` — is a separate change with its own blast radius
   * on every `confirmUpload` caller, and is deliberately left out of this one.
   */
  readonly interactive: IPolicy = wrap(
    retry(handleAll, {
      maxAttempts: 1,
      backoff: new ExponentialBackoff({ initialDelay: 200, maxDelay: 200 }),
    }),
    timeout(3_000, TimeoutStrategy.Aggressive),
  );

  /**
   * External API: 3 retries with jittered backoff, 10 s ceiling — so up to four calls and
   * a worst case near 41 s. Suitable for background and worker callers ONLY; anything a
   * user is waiting on wants `interactive` above.
   */
  readonly external: IPolicy = wrap(
    retry(handleAll, {
      maxAttempts: 3,
      backoff: new ExponentialBackoff({ initialDelay: 200, maxDelay: 2_000 }),
    }),
    timeout(10_000, TimeoutStrategy.Cooperative),
  );

  /** Database: 2 retries, 5 s ceiling, circuit-breaker trips after 5 consecutive failures */
  readonly database: IPolicy = wrap(
    retry(handleAll, {
      maxAttempts: 2,
      backoff: new ExponentialBackoff({ initialDelay: 100, maxDelay: 1_000 }),
    }),
    circuitBreaker(handleAll, {
      halfOpenAfter: 10_000,
      breaker: new ConsecutiveBreaker(5),
    }),
    timeout(5_000, TimeoutStrategy.Cooperative),
  );

  /** Cache: no retries, 1 s fast-fail (treat cache as optional) */
  readonly cache: IPolicy = timeout(1_000, TimeoutStrategy.Cooperative);

  /** Background jobs: 5 retries, 30 s ceiling */
  readonly background: IPolicy = wrap(
    retry(handleAll, {
      maxAttempts: 5,
      backoff: new ExponentialBackoff({ initialDelay: 500, maxDelay: 10_000 }),
    }),
    timeout(30_000, TimeoutStrategy.Cooperative),
  );

  /** @deprecated use named preset or execute() — kept for backward compat */
  get internal(): IPolicy { return this.database; }

  // ── Instrumented executor ─────────────────────────────────────────────────

  /**
   * Execute `fn` under `policy` and record OTel metrics.
   *
   * @param operation  Friendly name used as the `operation` attribute in metrics
   * @param policy     One of the named presets (this.external, this.database, …)
   * @param fn         The async work to protect
   *
   * @example
   *   const user = await this.resilience.execute(
   *     'graph.getUser',
   *     this.resilience.external,
   *     () => this.graphClient.getUser(id),
   *   );
   */
  async execute<T>(operation: string, policy: IPolicy, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    const attrs = { operation };
    try {
      const result = await policy.execute(fn);
      callsCounter.add(1, { ...attrs, outcome: 'success' });
      durationHistogram.record(Date.now() - start, attrs);
      return result;
    } catch (err) {
      const outcome = err instanceof BulkheadRejectedError ? 'bulkhead_rejected' : 'failure';
      callsCounter.add(1, { ...attrs, outcome });
      durationHistogram.record(Date.now() - start, attrs);
      throw err;
    }
  }

  // ── Bulkhead factory ──────────────────────────────────────────────────────

  /**
   * Create a bulkhead policy that limits concurrent executions.
   * Useful for isolating resource-intensive operations (e.g. large exports)
   * from normal request traffic.
   *
   * @param maxConcurrent  Max in-flight calls (excess → queued or rejected)
   * @param maxQueue       Max queued calls before BulkheadRejectedError is thrown
   */
  createBulkhead(maxConcurrent: number, maxQueue: number): IPolicy {
    return bulkhead(maxConcurrent, maxQueue);
  }

  /** One-off timeout-only policy (no retries). */
  withTimeout(ms: number): IPolicy {
    return timeout(ms, TimeoutStrategy.Cooperative);
  }
}
