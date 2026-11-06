import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { denied, result, type ToolContext } from './rest';
import { toToolAsset } from './list_assets';

/**
 * `opshub_get_asset` — one asset record (GET /v1/assets/:id, gated by `asset.read`).
 */
export function registerGetAsset(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'opshub_get_asset',
    {
      title: 'Get asset',
      description: 'One hardware asset by id, exactly what its detail page shows you.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        assetId: z.uuid().describe('The asset id'),
      },
    },
    async ({ assetId }) => {
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: `/v1/assets/${assetId}`,
      });
      if (statusCode >= 400 || json === null || typeof json !== 'object' || Array.isArray(json))
        return denied(statusCode, json);
      const a = json as Record<string, unknown>;
      return result(statusCode, json, {
        ...toToolAsset(a),
        serialNumber: a['serialNumber'] ?? null,
        purchaseDate: a['purchaseDate'] ?? null,
        warrantyExpiry: a['warrantyExpiry'] ?? null,
      });
    },
  );
}
