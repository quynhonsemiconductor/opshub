import type { RegisteredTool, McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerGetAsset } from './get_asset';
import { registerGetEmployee } from './get_employee';
import { registerGetRequest } from './get_request';
import { registerListAccessRequests } from './list_access_requests';
import { registerListAssets } from './list_assets';
import { registerListCatalog } from './list_catalog';
import { registerListDocuments } from './list_documents';
import { registerListEmployees } from './list_employees';
import { registerListNotifications } from './list_notifications';
import { registerListRequests } from './list_requests';
import { registerMyActiveGrants } from './my_active_grants';
import { registerMyLeaveBalance } from './my_leave_balance';
import { registerOutstandingDocuments } from './outstanding_documents';
import { registerUnreadNotifications } from './unread_notifications';
import { registerWhoami } from './whoami';
import type { ToolContext } from './rest';
import type { ToolName } from './registry';

/** One mounted tool, with its stable name (RegisteredTool itself carries no name). */
export interface MountedTool {
  name: ToolName;
  tool: RegisteredTool;
}

type Register = (server: McpServer, ctx: ToolContext) => RegisteredTool;

/**
 * The mounted catalogue, keyed by the SAME names `registry.ts` declares. `Record<ToolName, …>`
 * makes the two exhaustive against each other at compile time: a tool added to the registry but
 * not mounted here, or a typo'd name, is a type error rather than silent drift.
 */
const CATALOGUE: Record<ToolName, Register> = {
  opshub_whoami: registerWhoami,
  opshub_list_employees: registerListEmployees,
  opshub_get_employee: registerGetEmployee,
  opshub_list_assets: registerListAssets,
  opshub_get_asset: registerGetAsset,
  opshub_list_requests: registerListRequests,
  opshub_get_request: registerGetRequest,
  opshub_list_access_requests: registerListAccessRequests,
  opshub_my_active_grants: registerMyActiveGrants,
  opshub_list_catalog: registerListCatalog,
  opshub_my_leave_balance: registerMyLeaveBalance,
  opshub_outstanding_documents: registerOutstandingDocuments,
  opshub_list_documents: registerListDocuments,
  opshub_list_notifications: registerListNotifications,
  opshub_unread_notifications: registerUnreadNotifications,
};

/**
 * Mounts the P1 read-only catalogue on a fresh per-request server; returns what it mounted.
 * Task-shaped, not route-shaped (MCP-PLAN §4): the fifteen tools cover the questions an employee
 * actually asks an assistant — who am I, who is X, what do I hold, what is waiting on me, what
 * must I read or sign — and each still crosses the same `PolicyGuard` as the screen it mirrors.
 */
export function registerTools(server: McpServer, ctx: ToolContext): MountedTool[] {
  return (Object.entries(CATALOGUE) as Array<[ToolName, Register]>).map(([name, register]) => ({
    name,
    tool: register(server, ctx),
  }));
}
