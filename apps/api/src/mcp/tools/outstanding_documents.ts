import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { arrayResult, pageArgs, pageQuery, type ToolContext } from './rest';

/**
 * `opshub_outstanding_documents` — controlled-document versions the caller has not acknowledged
 * (GET /v1/documents/acknowledgements/outstanding, @SelfScoped). A new revision reappears here,
 * which is the ISO behaviour the route exists for.
 */
export function registerOutstandingDocuments(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'opshub_outstanding_documents',
    {
      title: 'Documents awaiting my acknowledgement',
      description: 'Published policy versions you have not acknowledged yet. Paginated.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: { ...pageArgs },
    },
    async ({ limit, cursor }) => {
      const page = pageQuery(limit, cursor);
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: '/v1/documents/acknowledgements/outstanding',
      });
      return arrayResult(
        statusCode,
        json,
        (d) => ({
          documentId: d['documentId'],
          code: d['code'],
          title: d['title'],
          category: d['category'],
          versionId: d['versionId'],
          version: d['version'],
          publishedAt: d['publishedAt'],
        }),
        'outstandingDocuments',
        page,
      );
    },
  );
}
