import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listResult, pageArgs, pageQuery, type ToolContext } from './rest';

/**
 * `opshub_list_requests` — the unified request inbox
 * (GET /v1/requests; the route narrows to requester-or-assignee unless the caller holds
 * `request.read`, and `myQueue` returns only what waits on them).
 */
export function registerListRequests(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'opshub_list_requests',
    {
      title: 'List requests',
      description:
        'List request items you can see in the web app. `myQueue` limits the result to items awaiting your decision. Paginated.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        type: z.string().optional().describe('Request type, e.g. the catalogue service key'),
        status: z
          .enum(['pending', 'in_review', 'approved', 'rejected', 'cancelled', 'expired'])
          .optional(),
        myQueue: z.boolean().optional().describe('Only requests awaiting your action'),
        ...pageArgs,
      },
    },
    async ({ type, status, myQueue, limit, cursor }) => {
      const page = pageQuery(limit, cursor);
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: '/v1/requests',
        query: { type, status, myQueue, ...page },
      });
      return listResult(
        statusCode,
        json,
        (r) => ({
          id: r['id'],
          type: r['type'],
          status: r['status'],
          priority: r['priority'],
          requesterName: r['requesterName'] ?? null,
          assigneeName: r['assigneeName'] ?? null,
          submittedAt: r['submittedAt'],
          currentStep: r['currentStep'],
          totalSteps: r['totalSteps'],
          viewerMayDecide: r['viewerMayDecide'],
        }),
        'requests',
        page,
      );
    },
  );
}
