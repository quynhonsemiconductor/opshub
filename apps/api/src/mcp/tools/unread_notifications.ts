import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { denied, result, type ToolContext } from './rest';

/**
 * `opshub_unread_notifications` — the caller's unread badge count
 * (GET /v1/notifications/unread-count, @SelfScoped).
 */
export function registerUnreadNotifications(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'opshub_unread_notifications',
    {
      title: 'Unread notification count',
      description: 'How many in-app notifications you have not read.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {},
    },
    async () => {
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: '/v1/notifications/unread-count',
      });
      if (statusCode >= 400 || json === null || typeof json !== 'object' || Array.isArray(json))
        return denied(statusCode >= 400 ? statusCode : 502, json);
      const c = json as Record<string, unknown>;
      return result(statusCode, json, { count: c['count'] });
    },
  );
}
