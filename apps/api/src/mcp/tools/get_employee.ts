import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { denied, result, type ToolContext } from './rest';
import { toToolEmployee } from './list_employees';

/**
 * `opshub_get_employee` — one employee record
 * (GET /v1/employees/:id, gated by `employee.read`).
 */
export function registerGetEmployee(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'opshub_get_employee',
    {
      title: 'Get employee',
      description: 'One employee record by id, exactly what the directory shows you.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        employeeId: z.uuid().describe('The employee id'),
      },
    },
    async ({ employeeId }) => {
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: `/v1/employees/${employeeId}`,
      });
      if (statusCode >= 400 || json === null || typeof json !== 'object' || Array.isArray(json))
        return denied(statusCode, json);
      const e = json as Record<string, unknown>;
      return result(statusCode, json, {
        ...toToolEmployee(e),
        managerId: e['managerId'] ?? null,
        roles: e['roles'] ?? [],
      });
    },
  );
}
