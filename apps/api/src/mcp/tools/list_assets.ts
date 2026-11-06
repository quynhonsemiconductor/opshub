import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listResult, pageArgs, pageQuery, type ToolContext } from './rest';

/** The small asset shape every asset tool returns. */
export function toToolAsset(a: Record<string, unknown>) {
  return {
    id: a['id'],
    assetTag: a['assetTag'],
    type: a['type'],
    status: a['status'],
    manufacturer: a['manufacturer'] ?? null,
    model: a['model'] ?? null,
    assignedTo: a['assignedTo'] ?? null,
  };
}

/**
 * `opshub_list_assets` — hardware assets and who holds them
 * (GET /v1/assets, gated by `asset.read`).
 */
export function registerListAssets(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'opshub_list_assets',
    {
      title: 'List assets',
      description:
        'Search hardware assets you can read in the web app, by tag, serial, model or holder. Paginated.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        search: z.string().optional().describe('Match asset tag, serial or model'),
        status: z.string().optional().describe('Asset status'),
        type: z.string().optional().describe('Asset type'),
        assignedTo: z.uuid().optional().describe('Only assets held by this employee id'),
        ...pageArgs,
      },
    },
    async ({ search, status, type, assignedTo, limit, cursor }) => {
      const page = pageQuery(limit, cursor);
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: '/v1/assets',
        query: { search, status, type, assignedTo, ...page },
      });
      return listResult(statusCode, json, toToolAsset, 'assets', page);
    },
  );
}
