import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';
import { CacheService } from '@quynhonsemiconductor/platform-cache';
import { prepareHttpApp } from '@quynhonsemiconductor/platform-runtime/bootstrap';
import { setUserBanned, type Identity } from '@quynhonsemiconductor/identity';
import { AUTH } from '@quynhonsemiconductor/identity/nest';
import { DRIZZLE, type DrizzleDB } from '@platform';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiAppOptions } from '../../apps/api/src/app-options';
import { registerMcpRoute } from '../../apps/api/src/mcp/index';
import type { McpAccessPrincipal, McpAccessVerifier } from '../../apps/api/src/mcp/index';
import { employees } from '../../db/schema';
import { FIXTURE, login } from './support/harness';

/**
 * `/mcp` through the REAL guard chain (real AppModule, real bootstrap, real Valkey, real
 * PolicyGuard), with only the Access-JWT verifier bound directly to fixture people — the one
 * piece that needs a live Cloudflare team to mint. Pins what the unit specs cannot:
 *
 *  - GUARD ORDER is real: the bridge runs before identity's SessionGuard, whose ban check then
 *    refuses a banned person on the injected call;
 *  - gate g: a tool returns byte-identical authorization results to the person's own session —
 *    same allow, same 403;
 *  - the in-process principal cannot be forged from the network.
 */

const PEOPLE = [FIXTURE.HR, FIXTURE.NO_PERMISSIONS] as const;
/** Three base64url segments: the route only accepts a bearer that is JWT-shaped. */
const VERIFIER_TOKEN_PREFIX = 'e2e.access.';

describe('/mcp over the real guard chain (e2e)', () => {
  let app: NestFastifyApplication;
  let fastify: FastifyInstance;
  let db: DrizzleDB;
  /** Every line the shared logger wrote during this suite, for the log-capture assertions. */
  const logLines: string[] = [];
  const people = new Map<string, McpAccessPrincipal>();
  const verifier: McpAccessVerifier = {
    verify: (bearer) => Promise.resolve(people.get(bearer) ?? null),
  };

  interface JsonRpc {
    error?: string;
    result?: { content?: { type: string; text: string }[]; tools?: { name: string }[] };
  }

  async function rpc(token: string, body: object, headerOnly = true) {
    const res = await fastify.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(headerOnly
          ? { 'cf-access-jwt-assertion': token }
          : { authorization: `Bearer ${token}` }),
      },
      payload: body,
    });
    return { statusCode: res.statusCode, json: res.json<JsonRpc>() };
  }

  async function initialize(token: string) {
    const init = await rpc(token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'e2e', version: '0.0.0' },
      },
    });
    expect(init.statusCode, JSON.stringify(init.json)).toBe(200);
  }

  async function callTool(token: string, name: string, args: Record<string, unknown>) {
    const res = await rpc(token, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    expect(res.statusCode, JSON.stringify(res.json)).toBe(200);
    return JSON.parse(res.json.result!.content![0].text) as Record<string, unknown>;
  }

  beforeAll(async () => {
    // The production boot, with /mcp registered before Fastify's routing table is finalized.
    app = await prepareHttpApp({
      ...apiAppOptions,
      env: { ...process.env, LOG_PRETTY: 'false', LOG_LEVEL: 'info' },
      logStream: { write: (line: string) => logLines.push(line) },
    });
    fastify = app.getHttpAdapter().getInstance();
    db = app.get(DRIZZLE);
    registerMcpRoute({
      app,
      fastify,
      verifier,
      cache: app.get(CacheService),
      serverVersion: 'e2e',
    });
    await app.init();
    await fastify.ready();

    const rows = await db
      .select({ id: employees.id, email: employees.email, name: employees.displayName })
      .from(employees)
      .where(
        inArray(
          employees.id,
          PEOPLE.map((p) => p.id),
        ),
      );
    for (const employee of rows) {
      const token = `${VERIFIER_TOKEN_PREFIX}${employee.email}`;
      people.set(token, { userId: employee.id, email: employee.email, name: employee.name });
    }
    expect(people.size).toBe(PEOPLE.length);
  });

  afterAll(async () => {
    await app?.close();
  });

  const tokenFor = (email: string) => `${VERIFIER_TOKEN_PREFIX}${email}`;

  it('a tool returns what the person themselves sees: whoami parity (gate g)', async () => {
    const session = await login(app, FIXTURE.HR);
    const direct = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie: session.sessionCookie },
    });
    expect(direct.statusCode).toBe(200);
    const me = direct.json<{ sub: string; email: string; name: string; roles: string[] }>();

    await initialize(tokenFor(FIXTURE.HR.email));
    const out = await callTool(tokenFor(FIXTURE.HR.email), 'opshub_whoami', {});
    // same person, same roles; the tool deliberately omits the permission matrix and CSRF token
    expect(out).toEqual({ id: me.sub, email: me.email, name: me.name, roles: me.roles });
  });

  it('a denial is the SAME denial the person’s REST call gets (gate g, per tool)', async () => {
    const session = await login(app, FIXTURE.NO_PERMISSIONS);
    const direct = await app.inject({
      method: 'GET',
      url: '/v1/employees',
      headers: { cookie: session.sessionCookie },
    });
    expect(direct.statusCode).toBe(403);

    await initialize(tokenFor(FIXTURE.NO_PERMISSIONS.email));
    const out = await callTool(tokenFor(FIXTURE.NO_PERMISSIONS.email), 'opshub_list_employees', {});
    expect(out['statusCode']).toBe(403);

    // The in-service scoped list is 200 + empty for the same principal, matching its REST route.
    const own = await app.inject({
      method: 'GET',
      url: '/v1/requests',
      headers: { cookie: session.sessionCookie },
    });
    expect(own.statusCode).toBe(200);
    const viaTool = await callTool(
      tokenFor(FIXTURE.NO_PERMISSIONS.email),
      'opshub_list_requests',
      {},
    );
    expect(viaTool['requests']).toEqual(
      (own.json<{ data: unknown[] }>().data ?? []).map((row) => {
        const r = row as Record<string, unknown>;
        return {
          id: r['id'],
          type: r['type'],
          status: r['status'],
          priority: r['priority'],
          requesterName: r['requesterName'] ?? null,
          assigneeName: r['assigneeName'] ?? null,
          submittedAt: r['submittedAt'],
          currentStep: r['currentStep'],
          totalSteps: r['totalSteps'],
          viewerMayDecide: r['viewerMayDecide'],
        };
      }),
    );
  });

  it('the production path: Cf-Access-Jwt-Assertion ALONE authenticates the request', async () => {
    await initialize(tokenFor(FIXTURE.HR.email));
    const out = await callTool(tokenFor(FIXTURE.HR.email), 'opshub_whoami', {});
    expect(out['id']).toBe(FIXTURE.HR.id);
  });

  it('the in-process principal cannot be forged: a network request with the header is not authenticated', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.getHttpServer().address() as AddressInfo;

    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/v1/auth/me',
          // The in-process principal travels in `authorization`; a network request carrying a
          // forged value must not become anybody.
          headers: { authorization: 'Bearer forged-token', 'cf-access-jwt-assertion': 'a.b.c' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(401);
  });

  it('a banned person is refused through the bridge — SessionGuard’s ban check fires on the injected call', async () => {
    const token = tokenFor(FIXTURE.HR.email);
    await initialize(token);
    expect((await callTool(token, 'opshub_whoami', {}))['id']).toBe(FIXTURE.HR.id);

    const auth = app.get<Identity>(AUTH);
    try {
      await setUserBanned(auth, FIXTURE.HR.id, true, 'e2e: ban the mcp user');
      const out = await callTool(token, 'opshub_whoami', {});
      // the tool relayed the person's own 401, unchanged
      expect(out['statusCode']).toBe(401);
    } finally {
      await setUserBanned(auth, FIXTURE.HR.id, false, 'e2e: restore the mcp user');
    }
    expect((await callTool(token, 'opshub_whoami', {}))['id']).toBe(FIXTURE.HR.id);
  });

  it('the access log never carries an MCP search term — length only', async () => {
    const token = tokenFor(FIXTURE.HR.email);
    await initialize(token);
    const marker = 'mcp-search-marker-9f3c';
    const out = await callTool(token, 'opshub_list_employees', { search: marker });
    // the query reached the route (the bridge works), while the log never saw it
    expect((out['employees'] as unknown[]).length).toBe(0);
    // pino writes asynchronously; one turn is enough for the access line to land
    await new Promise((resolve) => setImmediate(resolve));
    expect(logLines.length).toBeGreaterThan(0);
    expect(logLines.join('\n')).not.toContain(marker);
  });

  it('tools/list is the budgeted read-only catalogue', async () => {
    const token = tokenFor(FIXTURE.HR.email);
    await initialize(token);
    const list = await rpc(token, { jsonrpc: '2.0', id: 3, method: 'tools/list' });
    expect(list.json.result!.tools!.map((t) => t.name).sort()).toEqual([
      'opshub_get_asset',
      'opshub_get_employee',
      'opshub_get_request',
      'opshub_list_assets',
      'opshub_list_employees',
      'opshub_list_requests',
      'opshub_whoami',
    ]);
  });
});
