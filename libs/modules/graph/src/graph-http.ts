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
 * A hard per-request deadline: every HTTP request the client makes (including a redirect hop) carries
 * `AbortSignal.timeout(ms)`, which also covers reading the response body. The SDK has none.
 *
 * WHY IT MATTERS. A relay's lease must outlive every call its task makes, or a call can still be in
 * flight after another worker has re-claimed the row. The timeout is what makes
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
    await this.next!.execute(context);
  }
}

/**
 * The middleware chain the Graph client uses. The SDK's default chain, with two deliberate changes:
 *
 *   - NO `RetryHandler`. It would retry 429/503/504 up to three times, each wait up to the server's
 *     Retry-After (it honours up to 180 s), inside ONE call, with no overall bound. The relay is the
 *     only retry: it classifies the failure, honours Retry-After up to a clamp, spends an attempt, and
 *     releases the lease while it waits. A retry hidden inside a call can outlive the call's lease, and
 *     then land after another worker has acted on newer state.
 *   - A {@link TimeoutHandler} just above the HTTP handler, so every hop is bounded.
 */
export function buildGraphMiddleware(
  authProvider: AuthenticationProvider,
  timeoutMs: number = GRAPH_CALL_TIMEOUT_MS,
): Middleware[] {
  const chain: Middleware[] = [
    new AuthenticationHandler(authProvider),
    new RedirectHandler(new RedirectHandlerOptions()),
    new TelemetryHandler(),
    new TimeoutHandler(timeoutMs),
    new HTTPMessageHandler(),
  ];
  for (let i = 0; i < chain.length - 1; i += 1) chain[i].setNext!(chain[i + 1]);
  return chain;
}
