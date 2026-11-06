import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listResult, pageArgs, pageQuery, type ToolContext } from './rest';

/**
 * `opshub_list_documents` — the controlled-document library
 * (GET /v1/documents, gated by `documents.read`).
 */
export function registerListDocuments(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'opshub_list_documents',
    {
      title: 'List controlled documents',
      description:
        'Controlled documents you can read in the web app. Retired documents are excluded unless asked for. Paginated.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        search: z.string().optional().describe('Match code or title'),
        category: z.string().optional(),
        includeRetired: z.boolean().optional(),
        ...pageArgs,
      },
    },
    async ({ search, category, includeRetired, limit, cursor }) => {
      const page = pageQuery(limit, cursor);
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: '/v1/documents',
        query: {
          search,
          category,
          includeRetired: includeRetired === undefined ? undefined : String(includeRetired),
          ...page,
        },
      });
      return listResult(
        statusCode,
        json,
        (d) => ({
          id: d['id'],
          code: d['code'],
          title: d['title'],
          category: d['category'],
          ownerName: d['ownerName'] ?? null,
          retiredAt: d['retiredAt'] ?? null,
        }),
        'documents',
        page,
      );
    },
  );
}
