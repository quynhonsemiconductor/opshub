import type { RegisteredTool, McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerGetAsset } from './get_asset';
import { registerGetEmployee } from './get_employee';
import { registerGetRequest } from './get_request';
import { registerListAssets } from './list_assets';
import { registerListEmployees } from './list_employees';
import { registerListRequests } from './list_requests';
import { registerWhoami } from './whoami';
import type { ToolContext } from './rest';

/** One mounted tool, with its stable name (RegisteredTool itself carries no name). */
export interface MountedTool {
  name: string;
  tool: RegisteredTool;
}

/** Mounts the P1 read-only catalogue on a fresh per-request server; returns what it mounted. */
export function registerTools(server: McpServer, ctx: ToolContext): MountedTool[] {
  return [
    { name: 'opshub_whoami', tool: registerWhoami(server, ctx) },
    { name: 'opshub_list_employees', tool: registerListEmployees(server, ctx) },
    { name: 'opshub_get_employee', tool: registerGetEmployee(server, ctx) },
    { name: 'opshub_list_assets', tool: registerListAssets(server, ctx) },
    { name: 'opshub_get_asset', tool: registerGetAsset(server, ctx) },
    { name: 'opshub_list_requests', tool: registerListRequests(server, ctx) },
    { name: 'opshub_get_request', tool: registerGetRequest(server, ctx) },
  ];
}
