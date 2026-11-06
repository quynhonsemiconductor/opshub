/**
 * The tool catalogue: every tool's name and the REST route it composes, in one table. This is
 * the ratchet's anchor (tools.routes.spec.ts asserts each route exists in the controllers) and
 * the stability contract — names are deprecated, never renamed (MCP-PLAN §11). Every name carries
 * the `opshub_` prefix, because the MCP portal fronts all apps and tool names must be unique
 * across them.
 */
export const TOOL_ROUTES = {
  opshub_whoami: { method: 'GET', url: '/v1/auth/me' },
  opshub_list_employees: { method: 'GET', url: '/v1/employees' },
  opshub_get_employee: { method: 'GET', url: '/v1/employees/:id' },
  opshub_list_assets: { method: 'GET', url: '/v1/assets' },
  opshub_get_asset: { method: 'GET', url: '/v1/assets/:id' },
  opshub_list_requests: { method: 'GET', url: '/v1/requests' },
  opshub_get_request: { method: 'GET', url: '/v1/requests/:id' },
} as const;

export type ToolName = keyof typeof TOOL_ROUTES;
