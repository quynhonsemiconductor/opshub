import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { TOOL_ROUTES } from './registry';
import { registerTools } from './register';

/**
 * MCP-PLAN §4 / gate g: every tool maps to a REAL route. The registry carries each tool's REST
 * method + path; this spec asserts the path appears in the controller that owns it — with the
 * authorization decorator beside it — so a route rename or deletion breaks THIS test until the
 * tool is updated, instead of rotting silently into 404s at agent time.
 *
 * A tool never bypasses `PolicyGuard`: a routed permission code must sit on the mapped method,
 * and the resolve-then-check and self-scoped routes must declare which they are.
 */

const CONTROLLERS = join(__dirname, '..', '..', '..', '..', '..', 'libs', 'modules');

interface Owner {
  file: string;
  controller: string;
  get: string;
  /** The route's @RequirePermission code, when it declares one. */
  permission?: string;
  /** The route decides inside the service, with the named check. */
  authorizedInService?: string;
  /** The route is @SharedRead (unowned reference data). */
  sharedRead?: boolean;
  /** The route is @SelfScoped (the caller's own data). */
  selfScoped?: boolean;
}

const OWNER: Record<keyof typeof TOOL_ROUTES, Owner> = {
  opshub_whoami: {
    file: 'identity/src/interface/http/auth.controller.ts',
    controller: "@Controller('auth')",
    get: "@Get('me')",
    selfScoped: true,
  },
  opshub_list_employees: {
    file: 'identity/src/interface/http/employees.controller.ts',
    controller: "@Controller('employees')",
    get: '@Get()',
    permission: "'employee.read'",
  },
  opshub_get_employee: {
    file: 'identity/src/interface/http/employees.controller.ts',
    controller: "@Controller('employees')",
    get: "@Get(':id')",
    permission: "'employee.read'",
  },
  opshub_list_assets: {
    file: 'assets/src/interface/http/assets.controller.ts',
    controller: "@Controller('assets')",
    get: '@Get()',
    permission: "'asset.read'",
  },
  opshub_get_asset: {
    file: 'assets/src/interface/http/assets.controller.ts',
    controller: "@Controller('assets')",
    get: "@Get(':id')",
    permission: "'asset.read'",
  },
  opshub_list_requests: {
    file: 'requests/src/interface/http/requests.controller.ts',
    controller: "@Controller('requests')",
    get: '@Get()',
    authorizedInService: 'narrows to requester-or-assignee unless the caller holds request.read',
  },
  opshub_get_request: {
    file: 'requests/src/interface/http/requests.controller.ts',
    controller: "@Controller('requests')",
    get: "@Get(':id')",
    authorizedInService: 'assertParty on requester/assignee, else request.read',
  },
  opshub_list_access_requests: {
    file: 'access-requests/src/interface/http/access-requests.controller.ts',
    controller: "@Controller('access-requests')",
    get: '@Get()',
    authorizedInService: 'narrows to the caller unless they hold access_request.read',
  },
  opshub_my_active_grants: {
    file: 'access-requests/src/interface/http/access-requests.controller.ts',
    controller: "@Controller('access-requests')",
    get: "@Get('grants/me/active')",
    selfScoped: true,
  },
  opshub_list_catalog: {
    file: 'catalog/src/interface/http/catalog.controller.ts',
    controller: "@Controller('catalog')",
    get: '@Get()',
    sharedRead: true,
  },
  opshub_my_leave_balance: {
    file: 'workforce/src/interface/http/workforce.controller.ts',
    controller: "@Controller('workforce')",
    get: "@Get('leave/balance')",
    authorizedInService: 'optional employeeId',
  },
  opshub_outstanding_documents: {
    file: 'documents/src/interface/http/documents.controller.ts',
    controller: "@Controller('documents')",
    get: "@Get('acknowledgements/outstanding')",
    selfScoped: true,
  },
  opshub_list_documents: {
    file: 'documents/src/interface/http/documents.controller.ts',
    controller: "@Controller('documents')",
    get: '@Get()',
    permission: "'documents.read'",
  },
  opshub_list_notifications: {
    file: 'notifications/src/interface/http/notifications.controller.ts',
    controller: "@Controller('notifications')",
    get: '@Get()',
    selfScoped: true,
  },
  opshub_unread_notifications: {
    file: 'notifications/src/interface/http/notifications.controller.ts',
    controller: "@Controller('notifications')",
    get: "@Get('unread-count')",
    selfScoped: true,
  },
};

/** The decorated declaration from `from` to the next route decorator (or 1,500 chars). */
function decoratorBlock(src: string, from: number): string {
  const next = src.slice(from + 1).search(/\n {2}@(Get|Post|Patch|Put|Delete)\(/);
  return next === -1 ? src.slice(from, from + 1500) : src.slice(from, from + 1 + next);
}

describe('MCP tool catalogue maps to real routes', () => {
  it('registerTools mounts EXACTLY the names in TOOL_ROUTES — no drift in either direction', () => {
    const server = new McpServer({ name: 'spec', version: '0.0.0' });
    const mounted = registerTools(server, {
      principal: { userId: 'u-1', email: 'jane@qnsc.vn', name: 'Jane', sessionId: 'mcp:1' },
      callRest: () => Promise.resolve({ statusCode: 200, json: {} }),
    });
    expect(mounted.map((t) => t.name).sort()).toEqual(Object.keys(TOOL_ROUTES).sort());
  });

  it('every registered tool route exists in the owning controller', () => {
    const names = Object.keys(TOOL_ROUTES) as (keyof typeof TOOL_ROUTES)[];
    expect(names.sort()).toEqual([
      'opshub_get_asset',
      'opshub_get_employee',
      'opshub_get_request',
      'opshub_list_access_requests',
      'opshub_list_assets',
      'opshub_list_catalog',
      'opshub_list_documents',
      'opshub_list_employees',
      'opshub_list_notifications',
      'opshub_list_requests',
      'opshub_my_active_grants',
      'opshub_my_leave_balance',
      'opshub_outstanding_documents',
      'opshub_unread_notifications',
      'opshub_whoami',
    ]);
    for (const name of names) {
      const src = readFileSync(join(CONTROLLERS, OWNER[name].file), 'utf8');
      expect(src.includes(OWNER[name].controller), `${name}: controller prefix moved`).toBe(true);
      expect(src.includes(OWNER[name].get), `${name}: route decorator moved`).toBe(true);
      expect(TOOL_ROUTES[name].method).toBe('GET');

      // anchored at a line start: prose may mention decorators inside comments
      const from = src.indexOf('\n  ' + OWNER[name].get);
      expect(from, `${name}: route decorator not found`).toBeGreaterThan(-1);
      const block = decoratorBlock(src, from);
      if (OWNER[name].permission) {
        expect(block.includes(OWNER[name].permission), `${name}: permission code moved`).toBe(true);
      }
      if (OWNER[name].authorizedInService) {
        expect(
          block.includes('@AuthorizedInService'),
          `${name}: expected @AuthorizedInService on the resolve-then-check route`,
        ).toBe(true);
        expect(
          block.includes(OWNER[name].authorizedInService),
          `${name}: in-service check moved`,
        ).toBe(true);
      }
      if (OWNER[name].sharedRead) {
        expect(
          block.includes('@SharedRead('),
          `${name}: expected @SharedRead on the mapped method`,
        ).toBe(true);
      }
      if (OWNER[name].selfScoped) {
        expect(
          block.includes('@SelfScoped('),
          `${name}: expected @SelfScoped on the mapped method`,
        ).toBe(true);
      }
    }
  });
});
