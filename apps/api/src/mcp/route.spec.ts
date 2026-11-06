import {
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Req,
  UnauthorizedException,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { CacheService } from '@quynhonsemiconductor/platform-cache';
import { enableCorrelationId } from '@quynhonsemiconductor/platform-http';
import {
  accessTokenOf,
  McpAccessDeniedError,
  McpModule,
  registerMcpRoute,
  UNCONFIGURED_MCP_ACCESS_VERIFIER,
} from './index';
import type { McpAccessVerifier } from './access-verifier';

/**
 * `/mcp` against a live Fastify server (no port — `inject`), with the SAME wiring the bootstrap
 * uses (raw route + McpModule's global principal guard). The REST side is a fixture module
 * standing in for the real controllers: it sits behind the same principal bridge, so these specs
 * prove the BRIDGE — same principal, same refusal, per-person rate-limit key — not product rules
 * (those are the modules' own specs and the e2e suite).
 */

const VICTIM = '0194a000-0000-7000-8000-0000000000aa';
const RESTRICTED = '0194a000-0000-7000-8000-000000000004';
const UNKNOWN = '00000000-0000-7000-8000-0000000000e1';
// JWT-shaped on purpose: an opaque bearer alone is not accepted, and direct clients (this spec
// included) send the Access JWT itself as the bearer.
const VICTIM_TOKEN = 'victim-header.victim-payload.victim-signature';
const RESTRICTED_TOKEN = 'restricted-header.restricted-payload.restricted-signature';

const verifier: McpAccessVerifier = {
  verify: (bearer) =>
    Promise.resolve(
      bearer === VICTIM_TOKEN
        ? { userId: VICTIM, email: 'employee@opshub.local', name: 'Employee' }
        : bearer === RESTRICTED_TOKEN
          ? { userId: RESTRICTED, email: 'hr@opshub.local', name: 'HR' }
          : null,
    ),
};

/** Records the keys the route asks for; always admits. */
const consumedKeys: string[] = [];
const cache = {
  consumeRateLimit: (key: string) => {
    consumedKeys.push(key);
    return Promise.resolve({ allowed: true, remaining: 59, resetAt: 0 });
  },
} as unknown as CacheService;

/** Stands in for identity's global SessionGuard: no principal, no entry. */
@Injectable()
class RequirePrincipalGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ user?: { sub: string } }>();
    if (!req.user?.sub) throw new UnauthorizedException('Sign in required');
    return true;
  }
}

interface R {
  user?: { sub: string; email: string; name: string };
  query: Record<string, string>;
}

const ASSET = {
  id: '0194a000-0000-7000-8000-000000000201',
  assetTag: 'LT-0042',
  type: 'laptop',
  status: 'assigned',
  manufacturer: 'Dell',
  model: 'XPS 13',
  serialNumber: 'SN-42',
  purchaseDate: '2025-01-10',
  warrantyExpiry: '2028-01-10',
  assignedTo: VICTIM,
};

@Controller('auth')
@UseGuards(RequirePrincipalGuard)
class FixtureAuthController {
  @Get('me')
  me(@Req() req: R) {
    return {
      sub: req.user!.sub,
      email: req.user!.email,
      name: req.user!.name,
      roles: ['employee'],
      permissions: ['asset.read'],
      csrfToken: 'must-not-leak',
    };
  }
}

@Controller('employees')
@UseGuards(RequirePrincipalGuard)
class FixtureEmployeesController {
  @Get()
  list(@Req() req: R) {
    if (req.user!.sub === RESTRICTED) throw new ForbiddenException('Forbidden resource');
    return {
      data: [
        {
          id: VICTIM,
          email: 'employee@opshub.local',
          displayName: 'Employee',
          department: 'Ops',
          jobTitle: 'Operator',
          managerId: null,
          roles: ['employee'],
          status: 'active',
        },
      ],
      pageInfo: { total: 2, limit: Number(req.query['limit'] ?? 20), offset: 0, hasNextPage: true },
    };
  }

  @Get(':id')
  one(@Param('id') id: string) {
    if (id === UNKNOWN) throw new NotFoundException('Employee not found');
    return {
      id,
      email: 'employee@opshub.local',
      displayName: 'Employee',
      department: 'Ops',
      jobTitle: 'Operator',
      managerId: null,
      roles: ['employee'],
      status: 'active',
    };
  }
}

@Controller('assets')
@UseGuards(RequirePrincipalGuard)
class FixtureAssetsController {
  @Get()
  list(@Req() req: R) {
    if (req.user!.sub === RESTRICTED) throw new ForbiddenException('Forbidden resource');
    return { data: [ASSET], pageInfo: { total: 1, limit: 20, offset: 0, hasNextPage: false } };
  }

  @Get(':id')
  one(@Param('id') id: string) {
    if (id === UNKNOWN) throw new ForbiddenException('Forbidden resource');
    return { ...ASSET, id };
  }
}

@Controller('requests')
@UseGuards(RequirePrincipalGuard)
class FixtureRequestsController {
  @Get()
  list(@Req() req: R) {
    if (req.user!.sub === RESTRICTED) throw new ForbiddenException('Forbidden resource');
    return {
      data: [
        {
          id: '0194a000-0000-7000-8000-000000000301',
          type: 'laptop',
          status: 'pending',
          priority: 'normal',
          requesterName: 'Employee',
          assigneeName: null,
          submittedAt: '2026-11-01T00:00:00.000Z',
          currentStep: 1,
          totalSteps: 2,
          viewerMayDecide: false,
        },
      ],
      pageInfo: { total: 1, limit: 20, offset: 0, hasNextPage: false },
    };
  }

  @Get(':id')
  one(@Param('id') id: string) {
    if (id === UNKNOWN) throw new NotFoundException('Request not found');
    return {
      id,
      type: 'laptop',
      status: 'pending',
      priority: 'normal',
      requesterName: 'Employee',
      assigneeName: null,
      payload: { model: 'XPS 13' },
      resolutionNote: null,
      submittedAt: '2026-11-01T00:00:00.000Z',
      resolvedAt: null,
      currentStep: 1,
      totalSteps: 2,
      viewerMayDecide: false,
      viewerCannotDecideReason: 'own_request',
      approvals: [
        {
          step: 1,
          approverName: 'Manager',
          decision: 'approved',
          decidedAt: '2026-11-02T00:00:00.000Z',
          delegatedFromId: null,
          note: 'skip me',
        },
      ],
    };
  }
}

@Module({
  imports: [McpModule],
  controllers: [
    FixtureAuthController,
    FixtureEmployeesController,
    FixtureAssetsController,
    FixtureRequestsController,
  ],
})
class FixtureModule {}

interface JsonRpc {
  error?: string;
  result?: {
    content?: { type: string; text: string }[];
    tools?: { name: string; inputSchema?: unknown; annotations?: { readOnlyHint?: boolean } }[];
  };
}

async function boot(
  verifierOverride: McpAccessVerifier = verifier,
  cacheOverride: CacheService = cache,
) {
  const app = await NestFactory.create<NestFastifyApplication>(
    FixtureModule,
    new FastifyAdapter({ logger: false }),
    { bufferLogs: true, logger: false, abortOnError: false },
  );
  enableCorrelationId(app);
  // The tool registry names production paths (`/v1/...`); the raw `/mcp` route is outside the
  // prefix, exactly as in the real bootstrap.
  app.setGlobalPrefix('v1');
  const fastify = app.getHttpAdapter().getInstance();
  registerMcpRoute({
    app,
    fastify,
    verifier: verifierOverride,
    cache: cacheOverride,
    serverVersion: '0.0.0-test',
  });
  await app.init();
  await fastify.ready();
  return { app, fastify };
}

const HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

async function rpc(
  fastify: FastifyInstance,
  token: string,
  body: object,
): Promise<{ statusCode: number; json: JsonRpc }> {
  const res = await fastify.inject({
    method: 'POST',
    url: '/mcp',
    headers: { ...HEADERS, authorization: `Bearer ${token}` },
    payload: body,
  });
  return { statusCode: res.statusCode, json: res.json<JsonRpc>() };
}

async function initialize(fastify: FastifyInstance, token: string) {
  const init = await rpc(fastify, token, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'spec', version: '0.0.0' },
    },
  });
  expect(init.statusCode, JSON.stringify(init.json)).toBe(200);
}

async function callTool(
  fastify: FastifyInstance,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await rpc(fastify, token, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  expect(res.statusCode, JSON.stringify(res.json)).toBe(200);
  return JSON.parse(res.json.result!.content![0].text) as Record<string, unknown>;
}

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  consumedKeys.length = 0;
});

describe('/mcp (stateless transport, principal bridge, per-person budget)', () => {
  it('answers 401 without an Access token, and the token is never read from a cookie', async () => {
    const { app, fastify } = await boot();
    cleanup = () => app.close();
    const res = await fastify.inject({
      method: 'POST',
      url: '/mcp',
      headers: HEADERS,
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error?: string }>().error).toMatch(/Cloudflare Access/);
  });

  it('rejects a JSON-RPC batch: one message per POST', async () => {
    const { app, fastify } = await boot();
    cleanup = () => app.close();
    const res = await fastify.inject({
      method: 'POST',
      url: '/mcp',
      headers: { ...HEADERS, authorization: `Bearer ${VICTIM_TOKEN}` },
      payload: [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }],
    });
    expect(res.statusCode).toBe(400);
  });

  it('an unverified token is one uniform 401', async () => {
    const { app, fastify } = await boot();
    cleanup = () => app.close();
    const res = await rpc(fastify, 'other-header.other-payload.other-signature', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    expect(res.statusCode).toBe(401);
  });

  it('an unknown or offboarded employee (adapter denial) is one uniform 403', async () => {
    const { app, fastify } = await boot({
      verify: () => {
        throw new McpAccessDeniedError();
      },
    });
    cleanup = () => app.close();
    const res = await rpc(fastify, VICTIM_TOKEN, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json.error).toBe('Forbidden');
  });

  it('a verifier that RAISES (JWKS failed) is a 503, never a 500 or a 401', async () => {
    const { app, fastify } = await boot({
      verify: () => {
        throw new Error('jwks_unavailable');
      },
    });
    cleanup = () => app.close();
    const res = await rpc(fastify, VICTIM_TOKEN, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    expect(res.statusCode).toBe(503);
    expect(res.json.error).toMatch(/verifier unavailable/);
  });

  it('an unconfigured verifier is a named 503', async () => {
    const { app, fastify } = await boot(UNCONFIGURED_MCP_ACCESS_VERIFIER);
    cleanup = () => app.close();
    const res = await rpc(fastify, VICTIM_TOKEN, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    expect(res.statusCode).toBe(503);
    expect(res.json.error).toMatch(/not configured/);
  });

  it('GET and DELETE are stateless: 405 with Allow: POST', async () => {
    const { app, fastify } = await boot();
    cleanup = () => app.close();
    for (const method of ['GET', 'DELETE'] as const) {
      const res = await fastify.inject({
        method,
        url: '/mcp',
        headers: { authorization: `Bearer ${VICTIM_TOKEN}` },
      });
      expect(res.statusCode).toBe(405);
      expect(res.headers['allow']).toBe('POST');
    }
  });

  it('enforces the per-PERSON budget before any tool runs, never per IP', async () => {
    const { app, fastify } = await boot();
    cleanup = () => app.close();
    await initialize(fastify, VICTIM_TOKEN);
    expect(consumedKeys).toEqual([`mcp:uid:${VICTIM}`]);

    const refusing = {
      consumeRateLimit: (key: string) => {
        consumedKeys.push(key);
        return Promise.resolve({
          allowed: false,
          remaining: 0,
          resetAt: Math.floor(Date.now() / 1000) + 30,
        });
      },
    } as unknown as CacheService;
    const second = await boot(verifier, refusing);
    cleanup = async () => {
      await app.close();
      await second.app.close();
    };
    const res = await rpc(second.fastify, VICTIM_TOKEN, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    expect(res.statusCode).toBe(429);
    expect(consumedKeys.filter((k) => k === `mcp:uid:${VICTIM}`).length).toBeGreaterThan(1);
  });

  it('fails OPEN when the rate limiter is unavailable, and the REST layer still authorizes', async () => {
    const broken = {
      consumeRateLimit: () => Promise.reject(new Error('valkey down')),
    } as unknown as CacheService;
    const { app, fastify } = await boot(verifier, broken);
    cleanup = () => app.close();
    await initialize(fastify, VICTIM_TOKEN);
    const out = await callTool(fastify, VICTIM_TOKEN, 'opshub_whoami', {});
    expect(out['id']).toBe(VICTIM);
  });

  it('TOOL BUDGET: the read-only catalogue is exactly the budgeted 7, and every tool is read-only', async () => {
    const { app, fastify } = await boot();
    cleanup = () => app.close();
    await initialize(fastify, VICTIM_TOKEN);
    const list = await rpc(fastify, VICTIM_TOKEN, { jsonrpc: '2.0', id: 3, method: 'tools/list' });
    const tools = list.json.result!.tools!;
    // MCP-PLAN §4: ~15-30 task-shaped tools per app, not 1:1 with routes. This app is a
    // read-only first slice and may grow to that ceiling; it may not drift past it silently.
    expect(tools.length).toBe(7);
    expect(tools.length).toBeLessThanOrEqual(20);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, `${tool.name} must be read-only`).toBe(true);
      expect(
        JSON.stringify(tool.inputSchema).match(/workspace|actorId|actorEmployeeId/i),
        `${tool.name} must not take an acting-identity argument`,
      ).toBeNull();
    }
    expect(tools.map((t) => t.name).sort()).toEqual([
      'opshub_get_asset',
      'opshub_get_employee',
      'opshub_get_request',
      'opshub_list_assets',
      'opshub_list_employees',
      'opshub_list_requests',
      'opshub_whoami',
    ]);
  });

  it('whoami runs the injected call AS the principal and does not leak the CSRF token', async () => {
    const { app, fastify } = await boot();
    cleanup = () => app.close();
    await initialize(fastify, VICTIM_TOKEN);
    const out = await callTool(fastify, VICTIM_TOKEN, 'opshub_whoami', {});
    expect(out).toEqual({
      id: VICTIM,
      email: 'employee@opshub.local',
      name: 'Employee',
      roles: ['employee'],
    });
  });

  it('a list tool maps rows and reports an opaque next cursor', async () => {
    const { app, fastify } = await boot();
    cleanup = () => app.close();
    await initialize(fastify, VICTIM_TOKEN);
    const out = await callTool(fastify, VICTIM_TOKEN, 'opshub_list_employees', { limit: 20 });
    expect((out['employees'] as unknown[]).length).toBe(1);
    const page = out['pageInfo'] as { total: number; hasNextPage: boolean; nextCursor: string };
    expect(page.total).toBe(2);
    expect(page.hasNextPage).toBe(true);
    expect(typeof page.nextCursor).toBe('string');
  });

  it('a REST refusal is relayed as isError with its own status, never shaped', async () => {
    const { app, fastify } = await boot();
    cleanup = () => app.close();
    await initialize(fastify, RESTRICTED_TOKEN);
    const res = await rpc(fastify, RESTRICTED_TOKEN, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'opshub_list_employees', arguments: {} },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json.result as { isError?: boolean; content?: { text: string }[] };
    expect(body.isError).toBe(true);
    const relayed = JSON.parse(body.content![0].text) as { statusCode: number };
    expect(relayed.statusCode).toBe(403);
  });

  it('an unknown id answers 404 through the tool, separate from the denial', async () => {
    const { app, fastify } = await boot();
    cleanup = () => app.close();
    await initialize(fastify, VICTIM_TOKEN);
    const out = await callTool(fastify, VICTIM_TOKEN, 'opshub_get_employee', {
      employeeId: UNKNOWN,
    });
    expect(out['statusCode']).toBe(404);
  });

  it('a token minted for one principal cannot become another: no tool takes an acting id', async () => {
    const { app, fastify } = await boot();
    cleanup = () => app.close();
    await initialize(fastify, VICTIM_TOKEN);
    const out = await callTool(fastify, VICTIM_TOKEN, 'opshub_get_request', {
      requestId: '0194a000-0000-7000-8000-000000000301',
    });
    expect(out['requesterName']).toBe('Employee');
  });

  it('the asset and request list/detail shapes are what the detail pages show', async () => {
    const { app, fastify } = await boot();
    cleanup = () => app.close();
    await initialize(fastify, VICTIM_TOKEN);

    const assets = await callTool(fastify, VICTIM_TOKEN, 'opshub_list_assets', {});
    const [asset] = assets['assets'] as Record<string, unknown>[];
    expect(asset).toMatchObject({ assetTag: 'LT-0042', model: 'XPS 13', assignedTo: VICTIM });
    expect((assets['pageInfo'] as { hasNextPage: boolean }).hasNextPage).toBe(false);

    const detail = await callTool(fastify, VICTIM_TOKEN, 'opshub_get_asset', {
      assetId: ASSET.id,
    });
    expect(detail).toMatchObject({ serialNumber: 'SN-42', warrantyExpiry: '2028-01-10' });

    const requests = await callTool(fastify, VICTIM_TOKEN, 'opshub_list_requests', {});
    const [request] = requests['requests'] as Record<string, unknown>[];
    expect(request).toMatchObject({ type: 'laptop', status: 'pending', currentStep: 1 });
  });
});

describe('accessTokenOf', () => {
  it('takes the Access assertion when present, and it is not overridden by the bearer', () => {
    expect(
      accessTokenOf({
        'cf-access-jwt-assertion': 'a.b.c',
        authorization: 'Bearer x.y.z',
      }),
    ).toBe('a.b.c');
  });

  it('fails closed on a blank, padded or repeated assertion', () => {
    expect(accessTokenOf({ 'cf-access-jwt-assertion': '   ' })).toBeUndefined();
    expect(accessTokenOf({ 'cf-access-jwt-assertion': ['a.b.c', 'x.y.z'] })).toBeUndefined();
  });

  it('accepts a JWT-shaped bearer only — an opaque token is never the identity', () => {
    expect(accessTokenOf({ authorization: 'Bearer a.b.c' })).toBe('a.b.c');
    expect(accessTokenOf({ authorization: 'Bearer opaque-access-token' })).toBeUndefined();
    expect(accessTokenOf({})).toBeUndefined();
  });
});
