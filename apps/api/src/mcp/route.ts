import { Logger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CacheService } from '@quynhonsemiconductor/platform-cache';
import { mintMcpCallToken, MCP_CALL_TOKEN_HEADER, type McpPrincipalContext } from '@platform';
import type { McpAccessPrincipal, McpAccessVerifier } from './access-verifier';
import { registerTools } from './tools/register';
import type { McpRestCaller } from './tools/rest';

/**
 * The `/mcp` route: stateless MCP transport — one request, one server, no session.
 *
 * Registered as a RAW Fastify route — outside `/v1`, the session guards, the CSRF gate and the
 * OpenAPI document — because its authentication is the Cloudflare Access identity, not a cookie,
 * and because the edge scopes the Access application to exactly this path (MCP-PLAN §5; §12
 * covers the discovery paths and the edge rate-limit row). MCP_ENABLED=false (the default
 * everywhere) registers nothing at all.
 *
 * With Access Managed OAuth the client's `Authorization` bearer is an OPAQUE Access OAuth token:
 * Access validates it at the edge and forwards the identity to the origin as the Access JWT in
 * the `Cf-Access-Jwt-Assertion` header, which is what this route verifies. A bearer is read only
 * when it is itself a JWT (direct clients and the existing tests); an opaque bearer alone is
 * never accepted.
 *
 * Per POST, in order:
 *  1. verify the Access JWT from `Cf-Access-Jwt-Assertion` (or a JWT-shaped bearer) via the
 *     {@link McpAccessVerifier} (the app-platform `identity/access-jwt` adapter; the
 *     unconfigured stub answers 503);
 *  2. resolve the principal ONCE — email → opshub employee, by the adapter — and hold it as the
 *     one {@link McpPrincipalContext} for every tool call of this request;
 *  3. rate-limit PER PERSON from that principal (never per IP: `inject()` traffic arrives from
 *     loopback, where IP carries no security meaning — MCP-PLAN §4);
 *  4. build one stateless `McpServer` + transport (`sessionIdGenerator: undefined`, JSON
 *     responses; SDK pinned at the verified version) with the read-only tools.
 *
 * Each tool call mints a SINGLE-USE in-process call token for the same principal and carries
 * only that token on the `inject()` (AsyncLocalStorage cannot span an `inject()` — Fastify gives
 * every request a fresh async context by design; see mcp-call-token.ts). `McpPrincipalGuard`
 * consumes the token and writes the principal where the guards already read it, so the injected
 * request crosses the same guards — and the same `PolicyGuard` decisions — as the person's own
 * session.
 */

/** Per-person MCP budget, tighter than the REST DEFAULT tier: one agent turn is dozens of calls. */
const MCP_RATE_LIMIT = { limit: 60, windowSeconds: 60 };

const routeLogger = new Logger('McpRoute');

export interface McpRouteDeps {
  app: NestFastifyApplication;
  fastify: FastifyInstance;
  verifier: McpAccessVerifier;
  cache: CacheService;
  /** Server version reported at `initialize` — the opshub package version. */
  serverVersion: string;
}

export function registerMcpRoute(deps: McpRouteDeps): void {
  const { app, fastify, verifier, cache } = deps;

  // Runs each tool's REST call with the request's ONE principal. The call token is minted here
  // (never in a tool) and is the only thing the inject() carries.
  const callRest: McpRestCaller = async (principal, rest) => {
    const query = rest.query
      ? Object.fromEntries(
          Object.entries(rest.query)
            .filter(([, v]) => v !== undefined)
            .map(([key, value]) => [key, String(value)]),
        )
      : undefined;
    const injected = await app.inject({
      method: rest.method,
      url: rest.url,
      ...(query ? { query } : {}),
      headers: { [MCP_CALL_TOKEN_HEADER]: mintMcpCallToken(principal) },
    });
    let json: Record<string, unknown> | unknown[] | undefined;
    try {
      json = injected.json();
    } catch {
      json = undefined;
    }
    return { statusCode: injected.statusCode, json };
  };

  fastify.post('/mcp', async (request, reply) => {
    const token = accessTokenOf(request.headers);
    if (!token) {
      return reply.code(401).send({ error: 'MCP requires a Cloudflare Access identity' });
    }

    // The principal is resolved ONCE, here: Access JWT → opshub employee. Nothing downstream
    // re-resolves it, and no tool argument can widen it.
    // Batching was removed in the 2025-06-18 protocol and the pinned SDK still ACCEPTS an array
    // body — one POST would be up to 100 tool calls while costing one rate-limit unit. One
    // message per POST, enforced here.
    if (Array.isArray(request.body)) {
      return reply.code(400).send({
        error: 'JSON-RPC batching is not supported: send one message per POST',
      });
    }

    let verified: McpAccessPrincipal;
    try {
      const result = await verifier.verify(token);
      if (!result) return reply.code(401).send({ error: 'Unverified Access token' });
      verified = result;
    } catch (err) {
      // The adapter refuses an unknown or offboarded employee: one uniform 403, already logged
      // inside the adapter with the Access `sub`, never distinguishing unknown from offboarded.
      if ((err as Error)?.name === 'McpAccessDeniedError') {
        return reply.code(403).send({ error: 'Forbidden' });
      }
      // Everything else a verifier can raise is infra, not the caller: an unconfigured adapter, a
      // JWKS fetch that failed. One uniform 503; never a 500, never a distinguishing 401.
      if ((err as Error)?.name === 'McpAccessNotConfiguredError') {
        return reply.code(503).send({ error: (err as Error).message });
      }
      return reply.code(503).send({ error: 'MCP access verifier unavailable' });
    }
    const principal: McpPrincipalContext = {
      userId: verified.userId,
      email: verified.email,
      name: verified.name,
      // The /mcp request id names this exchange in audit rows: MCP is stateless, no session.
      sessionId: `mcp:${request.id}`,
    };

    // Per person, from the VERIFIED principal — never per IP (MCP-PLAN §4). A cache outage FAILS
    // OPEN, like every other rate limiter in opshub: the budget is back-pressure, not authorization,
    // and the REST calls this route makes are themselves limited per person. The failure is logged
    // with the error class only — never the caller or their arguments.
    let allowed = true;
    let resetAt = 0;
    try {
      ({ allowed, resetAt } = await cache.consumeRateLimit(
        `mcp:uid:${principal.userId}`,
        MCP_RATE_LIMIT.limit,
        MCP_RATE_LIMIT.windowSeconds,
      ));
    } catch (err) {
      routeLogger.error(
        { err: (err as Error)?.constructor?.name },
        'MCP rate limiter unavailable — allowing the request (fail open)',
      );
    }
    if (!allowed) {
      const retryAfter = Math.max(resetAt - Math.floor(Date.now() / 1000), 1);
      return reply
        .code(429)
        .header('Retry-After', retryAfter)
        .send({ error: `Rate limit exceeded (MCP). Retry after ${retryAfter}s.` });
    }

    // Stateless: one McpServer + transport per request, no session id ever issued.
    const server = new McpServer(
      { name: 'opshub', version: deps.serverVersion },
      {
        instructions: 'OpsHub — read-only tools. Every result is what the person themselves sees.',
      },
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    registerTools(server, { principal, callRest });
    await server.connect(transport);
    reply.hijack();
    await transport.handleRequest(request.raw, reply.raw, request.body);
    return reply;
  });

  // GET (server-initiated SSE stream) and DELETE (session termination) exist only in stateful
  // mode; stateless answers 405, as the Streamable HTTP transport does for them itself.
  for (const method of ['GET', 'DELETE'] as const) {
    fastify.route({
      method,
      url: '/mcp',
      handler: (_req, reply) => {
        reply.code(405).header('Allow', 'POST').send({
          error: 'The opshub MCP endpoint is stateless: only POST is supported',
        });
      },
    });
  }
}

/**
 * The token the verifier checks. Cloudflare Access forwards the user identity to the origin as
 * the Access JWT in `Cf-Access-Jwt-Assertion` (under Managed OAuth the client's own bearer is an
 * opaque Access OAuth token the edge consumes, not a JWT this origin can verify). PRESENCE is
 * final: Cloudflare only forwards this header for a request Access authenticated, so a forged,
 * repeated (an array: no canonical order) or blank header fails closed and never falls back to
 * the bearer. Direct clients that send the Access JWT itself as a bearer keep working, but only
 * when that value is JWT-shaped (three base64url segments); an opaque bearer alone is never
 * accepted.
 */
export function accessTokenOf(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const assertion = headers['cf-access-jwt-assertion'];
  if (assertion !== undefined) {
    if (typeof assertion !== 'string') return undefined;
    const value = assertion.trim();
    return value === '' ? undefined : value;
  }
  const bearer = bearerOf(headers['authorization']);
  return bearer && isJwtShaped(bearer) ? bearer : undefined;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' && first.trim() !== '' ? first.trim() : undefined;
}

function isJwtShaped(token: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
}

function bearerOf(authorization: string | string[] | undefined): string | undefined {
  const value = firstHeader(authorization);
  if (!value) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match?.[1];
}
