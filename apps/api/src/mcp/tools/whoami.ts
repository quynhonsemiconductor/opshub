import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { result, type ToolContext } from './rest';

/**
 * `opshub_whoami` — the person as opshub sees them (GET /v1/auth/me, self-scoped).
 * Small: no permission array (that is the UI's business) and no CSRF token.
 */
export function registerWhoami(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'opshub_whoami',
    {
      title: 'Who am I',
      description: 'The signed-in person as OpsHub sees them: identity and application roles.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {},
    },
    async () => {
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: '/v1/auth/me',
      });
      const p = json as Record<string, unknown>;
      return result(statusCode, json, {
        id: p['sub'],
        email: p['email'],
        name: p['name'],
        roles: p['roles'] ?? [],
      });
    },
  );
}
