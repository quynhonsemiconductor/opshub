import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { denied, result, type ToolContext } from './rest';

/**
 * `opshub_get_request` — one request item with its approval history
 * (GET /v1/requests/:id; the route requires the caller to be a party, or to hold `request.read`).
 */
export function registerGetRequest(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'opshub_get_request',
    {
      title: 'Get request',
      description: 'One request item by id, with the steps it has been through.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        requestId: z.uuid().describe('The request id'),
      },
    },
    async ({ requestId }) => {
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: `/v1/requests/${requestId}`,
      });
      if (statusCode >= 400 || json === null || typeof json !== 'object' || Array.isArray(json))
        return denied(statusCode, json);
      const r = json as Record<string, unknown>;
      const approvals = Array.isArray(r['approvals'])
        ? (r['approvals'] as Record<string, unknown>[]).map((a) => ({
            step: a['step'],
            approverName: a['approverName'] ?? null,
            decision: a['decision'],
            decidedAt: a['decidedAt'],
            delegatedFromId: a['delegatedFromId'] ?? null,
          }))
        : [];
      return result(statusCode, json, {
        id: r['id'],
        type: r['type'],
        status: r['status'],
        priority: r['priority'],
        requesterName: r['requesterName'] ?? null,
        assigneeName: r['assigneeName'] ?? null,
        payload: r['payload'] ?? {},
        resolutionNote: r['resolutionNote'] ?? null,
        submittedAt: r['submittedAt'],
        resolvedAt: r['resolvedAt'] ?? null,
        currentStep: r['currentStep'],
        totalSteps: r['totalSteps'],
        viewerMayDecide: r['viewerMayDecide'],
        viewerCannotDecideReason: r['viewerCannotDecideReason'] ?? null,
        approvals,
      });
    },
  );
}
