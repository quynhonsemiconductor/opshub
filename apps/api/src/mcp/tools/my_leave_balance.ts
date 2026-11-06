import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { arrayResult, pageArgs, pageQuery, type ToolContext } from './rest';

/**
 * `opshub_my_leave_balance` — the caller's own leave balances for a year
 * (GET /v1/workforce/leave/balance, @AuthorizedInService; no employeeId is ever sent, so the
 * route always narrows to the caller).
 */
export function registerMyLeaveBalance(server: McpServer, ctx: ToolContext) {
  return server.registerTool(
    'opshub_my_leave_balance',
    {
      title: 'My leave balance',
      description:
        'Your leave balances. `availableDays` is what you can book now; `remainingDays` is what the year settles at.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        year: z.number().int().min(2000).max(2100).optional().describe('Defaults to this year'),
        ...pageArgs,
      },
    },
    async ({ year, limit, cursor }) => {
      const page = pageQuery(limit, cursor);
      const { statusCode, json } = await ctx.callRest(ctx.principal, {
        method: 'GET',
        url: '/v1/workforce/leave/balance',
        query: { year },
      });
      return arrayResult(
        statusCode,
        json,
        (b) => ({
          leaveType: b['leaveType'],
          year: b['year'],
          grantedDays: b['grantedDays'],
          accruedDays: b['accruedDays'],
          carriedOverDays: b['carriedOverDays'],
          carriedOverExpiresOn: b['carriedOverExpiresOn'] ?? null,
          consumedDays: b['consumedDays'],
          availableDays: b['availableDays'],
          remainingDays: b['remainingDays'],
        }),
        'balances',
        page,
      );
    },
  );
}
