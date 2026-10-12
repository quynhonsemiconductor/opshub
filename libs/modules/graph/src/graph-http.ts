import {
  AuthenticationHandler,
  HTTPMessageHandler,
  RedirectHandler,
  RedirectHandlerOptions,
  TelemetryHandler,
  type AuthenticationProvider,
  type Context,
  type Middleware,
} from '@microsoft/microsoft-graph-client';
import { GRAPH_CALL_TIMEOUT_MS } from './graph-task';

/**
 * A hard deadline over the WHOLE request: token acquisition, redirects and the HTTP call, response body
 * included. The SDK has none.
 *
 * FIRST IN THE CHAIN, on purpose. It used to sit just above the HTTP handler, which put the deadline
 * AFTER `AuthenticationHandler` awaited `getAccessToken()` — and MSAL has no default timeout and its own
 * retries. A token stall longer than the lease, then a stale PATCH, recreated the very race the deadline
 * exists to close. Now the clock starts before the token is requested, and:
 *
 *   - the call REJECTS at the deadline even if the token never arrives (`Promise.race` — token
 *     acquisition ignores an AbortSignal);
 *   - if the token arrives late, the request that follows carries the already-aborted signal, so `fetch`
 *     refuses it at once: no stale mutation is ever sent after the deadline.
 *
 * WHY IT MATTERS. A relay's lease must outlive every call its task makes, or a call can still be in
 * flight after another worker has re-claimed the row. The deadline is what makes
 * `lease > calls x timeout + margin` a statement that can be checked (see graph-task.ts).
 */
export class TimeoutHandler implements Middleware {
  private next: Middleware | undefined;

  constructor(private readonly timeoutMs: number) {}

  setNext(next: Middleware): void {
    this.next = next;
  }

  async execute(context: Context): Promise<void> {
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const existing = context.options?.signal;
    context.options = {
      ...context.options,
      signal: existing ? AbortSignal.any([existing, deadline]) : deadline,
    };

    let onAbort: (() => void) | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      onAbort = () =>
        reject(
          new GraphDeadlineError(
            `Microsoft Graph request exceeded its ${Math.round(this.timeoutMs / 1000)} s deadline`,
          ),
        );
      if (deadline.aborted) onAbort();
      else deadline.addEventListener('abort', onAbort, { once: true });
    });
    const running = this.next!.execute(context);
    // If the deadline wins, `running` may still settle later (a late token, then a refused fetch): that
    // outcome is nobody's business, and an unhandled rejection must not crash the process.
    running.catch(() => undefined);
    try {
      await Promise.race([running, expired]);
    } finally {
      if (onAbort) deadline.removeEventListener('abort', onAbort);
    }
  }
}

/** The request ran out of time (token acquisition included). Retryable like any transport failure. */
export class GraphDeadlineError extends Error {
  override readonly name = 'GraphDeadlineError';
}

/**
 * The middleware chain the Graph client uses. The SDK's default chain, with two deliberate changes:
 *
 *   - NO `RetryHandler`. It would retry 429/503/504 up to three times, each wait up to the server's
 *     Retry-After (it honours up to 180 s), inside ONE call, with no overall bound. The relay is the
 *     only retry: it classifies the failure, honours Retry-After up to a clamp, spends an attempt, and
 *     releases the lease while it waits. A retry hidden inside a call can outlive the call's lease, and
 *     then land after another worker has acted on newer state.
 *   - A {@link TimeoutHandler} FIRST, so one deadline covers token acquisition, redirects and the request.
 */
export function buildGraphMiddleware(
  authProvider: AuthenticationProvider,
  timeoutMs: number = GRAPH_CALL_TIMEOUT_MS,
): Middleware[] {
  const chain: Middleware[] = [
    new TimeoutHandler(timeoutMs),
    new AuthenticationHandler(authProvider),
    new RedirectHandler(new RedirectHandlerOptions()),
    new TelemetryHandler(),
    new HTTPMessageHandler(),
  ];
  for (let i = 0; i < chain.length - 1; i += 1) chain[i].setNext!(chain[i + 1]);
  return chain;
}
