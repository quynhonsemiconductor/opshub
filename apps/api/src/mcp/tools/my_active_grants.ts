import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { arrayResult, pageArgs, pageQuery, type ToolContext } from './rest';

/**
 * `opshub_my_active_grants` — the caller's own live privileged-access grants
 * (GET /v1/access-requests/grants/me/active, @SelfScoped).
 */
export function registerMyActiveGrants(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'opshub_my_active_grants',
    {
      title: 'My active grants',
      description: 'Privileged-access grants that are active for you right now. Paginated.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: { ...pageArgs },
    },
    async ({ limit, cursor }) => {
      const page = pageQuery(limit, cursor);
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: '/v1/access-requests/grants/me/active',
      });
      return arrayResult(
        statusCode,
        json,
        (g) => ({
          id: g['id'],
          requestId: g['requestId'],
          accessType: g['accessType'],
          target: g['target'],
          grantedAt: g['grantedAt'],
          expiresAt: g['expiresAt'],
        }),
        'grants',
        page,
      );
    },
  );
}
