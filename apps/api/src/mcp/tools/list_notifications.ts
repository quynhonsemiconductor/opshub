import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { denied, type ToolContext } from './rest';

/**
 * `opshub_list_notifications` — the caller's own in-app notifications
 * (GET /v1/notifications, @SelfScoped; this route is already cursor-paginated).
 */
export function registerListNotifications(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'opshub_list_notifications',
    {
      title: 'List my notifications',
      description: 'Your in-app notifications, newest first. Paginated.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        isRead: z.boolean().optional().describe('true = read only, false = unread only'),
        limit: z.number().int().min(1).max(20).optional().describe('Page size (default 20)'),
        cursor: z.string().optional().describe('Opaque cursor from the previous page'),
      },
    },
    async ({ isRead, limit, cursor }) => {
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: '/v1/notifications',
        query: {
          isRead: isRead === undefined ? undefined : String(isRead),
          limit: limit ?? 20,
          cursor,
        },
      });
      if (statusCode >= 400) return denied(statusCode, json);
      const page = json as { items?: unknown; nextCursor?: string | null } | null;
      if (!page || !Array.isArray(page.items)) {
        // A 2xx that is not { items, nextCursor } is contract drift: upstream failure, never a
        // successful empty list (same rule as listResult).
        return denied(502, json);
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              notifications: (page.items as Record<string, unknown>[]).map((n) => ({
                id: n['id'],
                type: n['type'],
                title: n['title'],
                body: n['body'] ?? null,
                resourceType: n['resourceType'] ?? null,
                resourceId: n['resourceId'] ?? null,
                isRead: n['isRead'],
                createdAt: n['createdAt'],
              })),
              pageInfo: { nextCursor: page.nextCursor ?? null },
            }),
          },
        ],
      };
    },
  );
}
