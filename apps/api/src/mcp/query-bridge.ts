import type { FastifyInstance } from 'fastify';
import { MCP_CALL_TOKEN_HEADER, peekMcpCallToken } from '@platform';

/**
 * Restores an injected MCP call's query parameters from its single-use call token.
 *
 * The tool caller deliberately keeps query params OUT of the URL: the access log and pino's
 * request binding record the URL, and a person's search text must not become a log entry. The
 * token is minted in-process, never visible on the wire, and carries the query alongside the
 * principal; this hook is the ONE place it is put back where the route's `@Query()` reads it.
 *
 * Registered unconditionally by the bootstrap, and inert without a live token, so the mechanism
 * cannot be omitted by a config flag. Extracted rather than inlined so the transport spec and the
 * bootstrap exercise the same function.
 */
export function registerMcpQueryBridge(fastify: FastifyInstance): void {
  fastify.addHook('onRequest', function mcpQueryBridge(req, _reply, done) {
    const pending = peekMcpCallToken(req.headers[MCP_CALL_TOKEN_HEADER]);
    if (pending?.query) {
      req.query = { ...(req.query as Record<string, string>), ...pending.query };
    }
    done();
  });
}
