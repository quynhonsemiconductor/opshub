import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listResult, pageArgs, pageQuery, type ToolContext } from './rest';

/** The small employee shape every employee tool returns. */
export function toToolEmployee(e: Record<string, unknown>) {
  return {
    id: e['id'],
    email: e['email'],
    displayName: e['displayName'],
    department: e['department'] ?? null,
    jobTitle: e['jobTitle'] ?? null,
    status: e['status'],
  };
}

/**
 * `opshub_list_employees` — the people directory
 * (GET /v1/employees, gated by `employee.read`).
 */
export function registerListEmployees(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'opshub_list_employees',
    {
      title: 'List employees',
      description:
        'Search the employee directory you can read in the web app, by name or address. Paginated.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        search: z.string().optional().describe('Match display name or email'),
        department: z.string().optional().describe('Exact department name'),
        status: z.enum(['active', 'on_leave', 'offboarded']).optional(),
        ...pageArgs,
      },
    },
    async ({ search, department, status, limit, cursor }) => {
      const page = pageQuery(limit, cursor);
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: '/v1/employees',
        query: { search, department, status, ...page },
      });
      return listResult(statusCode, json, toToolEmployee, 'employees', page);
    },
  );
}
