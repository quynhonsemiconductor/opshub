import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listResult, pageArgs, pageQuery, type ToolContext } from './rest';

/**
 * `opshub_list_access_requests` — privileged-access requests
 * (GET /v1/access-requests; the route narrows to the requester unless the caller holds
 * `access_request.read`).
 */
export function registerListAccessRequests(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'opshub_list_access_requests',
    {
      title: 'List access requests',
      description:
        'Privileged-access requests you can see in the web app; by default only your own. Paginated.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        status: z.enum(['pending', 'approved', 'rejected', 'expired', 'revoked']).optional(),
        ...pageArgs,
      },
    },
    async ({ status, limit, cursor }) => {
      const page = pageQuery(limit, cursor);
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: '/v1/access-requests',
        query: { status, ...page },
      });
      return listResult(
        statusCode,
        json,
        (r) => ({
          id: r['id'],
          accessType: r['accessType'],
          target: r['target'],
          durationHours: r['durationHours'],
          status: r['status'],
          reviewedAt: r['reviewedAt'] ?? null,
          createdAt: r['createdAt'],
        }),
        'accessRequests',
        page,
      );
    },
  );
}
