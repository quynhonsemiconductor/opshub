import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { arrayResult, pageArgs, pageQuery, type ToolContext } from './rest';

/**
 * `opshub_list_catalog` — the service catalogue every employee may browse
 * (GET /v1/catalog, @SharedRead). The route returns the whole active list; the tool slices it so
 * the agent-facing contract is the same limit + cursor as every other list.
 */
export function registerListCatalog(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'opshub_list_catalog',
    {
      title: 'List the service catalogue',
      description: 'Services an employee may request through OpsHub. Paginated.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: { ...pageArgs },
    },
    async ({ limit, cursor }) => {
      const page = pageQuery(limit, cursor);
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: '/v1/catalog',
      });
      return arrayResult(
        statusCode,
        json,
        (c) => ({
          id: c['id'],
          name: c['name'],
          description: c['description'] ?? null,
          category: c['category'],
          slaHours: c['slaHours'] ?? null,
        }),
        'catalog',
        page,
      );
    },
  );
}
