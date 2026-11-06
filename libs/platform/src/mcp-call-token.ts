import { randomBytes } from 'node:crypto';

/**
 * The in-process principal an MCP tool runs its REST calls as, carried by a SINGLE-USE call token.
 *
 * A platform primitive, not product code: the MCP transport mints one per tool call, and the
 * injected request reads it in exactly one place — the product's MCP principal guard, which
 * consumes it and writes the principal where the rest of the request pipeline already looks.
 *
 * WHY NOT AsyncLocalStorage (MCP-PLAN §4 expected one): Fastify deliberately gives every request a
 * FRESH async context — its content-type parser wraps the request in a new `AsyncResource`, so an
 * ALS store set around `inject()` is `undefined` inside the injected request's hooks and guards,
 * plain Fastify and Nest alike. ALS cannot span an `inject()` boundary, here or in production.
 *
 * So the bridge is a single-use token:
 *
 *  - `mintMcpCallToken` (only the MCP transport, per tool call) stores the principal under a
 *    256-bit random token, TTL seconds;
 *  - the transport carries ONLY the token — never the principal — on the `inject()`;
 *  - `consumeMcpCallToken` exchanges it ONCE: the first read deletes it, so it cannot be replayed.
 *
 * Nothing network-visible ever carries the principal: a token exists only inside the process, is
 * shown to nobody, and dies on first use. A network request cannot forge or replay it.
 */

/** Who an MCP tool call runs as. The values are resolved ONCE per /mcp request, by the adapter. */
export interface McpPrincipalContext {
  /** `identity.user.id`, which is `identity.employees.id`. */
  userId: string;
  /** The employee's address, used by self-scoped routes that echo the caller. */
  email: string;
  /** The employee's display name, same reason. */
  name: string;
  /** The /mcp request id, so the audit trail can name the exchange (MCP is stateless). */
  sessionId: string;
}

/**
 * Header the in-process call token travels in (between the MCP transport and its guard, never
 * stored, never on the wire). `authorization` is deliberate: the shared pino configuration
 * already redacts that header on every request line, so a credential cannot be written to the log
 * sink by a logger change made in another repository. Nothing reads an Authorization header for
 * authentication in opshub (sessions are cookies), and the guard consumes the token once.
 */
export const MCP_CALL_TOKEN_HEADER = 'authorization';

/** A token outlives its one inject() by seconds, not minutes. */
const TOKEN_TTL_MS = 5_000;

/** What a call token carries: the principal, plus the query the injected route must see. */
export interface McpCallEntry {
  principal: McpPrincipalContext;
  /**
   * Query parameters for the injected request. They travel in the token, NOT in the URL: the
   * access log records the request URL (and pino binds it to every line), and an MCP search term
   * must not become a log entry. The onRequest bridge puts these back on `request.query` before
   * the route handler reads them.
   */
  query?: Record<string, string>;
}

const pending = new Map<string, { entry: McpCallEntry; expiresAt: number }>();

function headerValue(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

/** Mints a single-use token standing for `principal`. Called ONLY by the MCP transport. */
export function mintMcpCallToken(
  principal: McpPrincipalContext,
  query?: Record<string, string>,
): string {
  // Sweep on EVERY mint: lazy-only expiry would let an unconsumed token (a @Public route, a 404,
  // a failed inject) hold the person's email, name and search terms for the life of the process.
  // The map is tiny, and an entry past TTL is dead whether or not anyone reads it.
  const now = Date.now();
  for (const [key, entry] of pending) {
    if (entry.expiresAt <= now) pending.delete(key);
  }
  const token = randomBytes(32).toString('base64url');
  const entry: McpCallEntry = { principal, ...(query ? { query } : {}) };
  pending.set(token, { entry, expiresAt: Date.now() + TOKEN_TTL_MS });
  return token;
}

/**
 * Exchanges a token for its principal, ONCE: the token is deleted on this read, whether or not
 * the exchange succeeds. `undefined` means no (or an already-used, unknown or expired) token —
 * the request carries no MCP context and falls through to the session path.
 */
export function consumeMcpCallToken(
  raw: string | string[] | undefined,
): McpPrincipalContext | undefined {
  const token = headerValue(raw);
  if (!token) return undefined;
  const entry = pending.get(token);
  pending.delete(token);
  if (!entry || entry.expiresAt <= Date.now()) return undefined;
  return entry.entry.principal;
}

/**
 * Reads a token WITHOUT consuming it: the onRequest query bridge needs the query before the
 * principal guard spends the one unlock.
 */
export function peekMcpCallToken(raw: string | string[] | undefined): McpCallEntry | undefined {
  const token = headerValue(raw);
  if (!token) return undefined;
  const entry = pending.get(token);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    pending.delete(token);
    return undefined;
  }
  return entry.entry;
}

/**
 * The bridge marker: set on a request ONLY by the MCP principal guard, right after it consumes a
 * live call token, and read by the route-level `SessionAuthGuard` so "how was this request
 * authenticated" is a checked fact, not an inference from `request.user`. A WeakSet of the request
 * objects: nothing to clean up, and nothing on the wire can set it — it never leaves the process.
 */
const bridgedRequests = new WeakSet<object>();

/** Marks `request` as authenticated by the MCP bridge. Call ONLY right after consuming a live token. */
export function markMcpBridged(request: object): void {
  bridgedRequests.add(request);
}

/** Whether the MCP principal guard authenticated this request. */
export function isMcpBridged(request: object): boolean {
  return bridgedRequests.has(request);
}
