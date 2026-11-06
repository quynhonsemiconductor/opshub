import { firstValueFrom, from, lastValueFrom, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@quynhonsemiconductor/platform-http';
import { HttpMetrics, requestContextStorage } from '@quynhonsemiconductor/observability';
import { HttpLoggingInterceptor } from './http-logging.interceptor';
import { markMcpBridged } from '../mcp-call-token';

/**
 * The access-log interceptor also feeds the RED metrics the HTTP alarms are written against. What matters:
 * the route label is the TEMPLATE (an id in a label mints a series per value), a domain error's status is the
 * one it carries (a 404 thrown as a DomainException must not count as a 5xx), and a request counts once.
 */

function setup(
  over: { url?: string; routeUrl?: string; status?: number; ip?: string; bridged?: boolean } = {},
) {
  const record = vi.spyOn(HttpMetrics.prototype, 'record').mockImplementation(() => undefined);
  const interceptor = new HttpLoggingInterceptor();
  // the access log goes to Nest's logger; keep the test output quiet
  const logger = (interceptor as unknown as { logger: Record<string, unknown> }).logger;
  const log = vi.fn();
  logger['log'] = log;
  logger['warn'] = log;
  logger['error'] = log;
  const req = {
    method: 'GET',
    url: over.url ?? '/v1/assets/019f8a00-0000-7000-8000-000000000001?x=1',
    headers: { 'cf-connecting-ip': over.ip ?? '203.0.113.7', 'x-real-ip': '192.0.2.99' },
    routeOptions: over.routeUrl === undefined ? { url: '/v1/assets/:id' } : { url: over.routeUrl },
    raw: { url: over.url ?? '/v1/assets/019f8a00-0000-7000-8000-000000000001?x=1' },
    body: undefined,
  };
  if (over.bridged) markMcpBridged(req);
  const res = { statusCode: over.status ?? 200 };
  const context = {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as never;
  return { interceptor, context, record, log, req };
}

afterEach(() => vi.restoreAllMocks());

describe('HttpLoggingInterceptor', () => {
  it('logs the user from the request context, never from req.user', async () => {
    const { interceptor, context, log, req } = setup();
    Object.assign(req, { user: { id: 'from-req-user' } });

    await requestContextStorage.run(
      {
        workspaceId: undefined,
        userId: 'emp-1',
        sessionId: 's-1',
        correlationId: 'c-1',
        traceparent: undefined,
      },
      () => firstValueFrom(interceptor.intercept(context, { handle: () => of({}) })),
    );

    expect(log).toHaveBeenCalledWith(expect.objectContaining({ userId: 'emp-1' }));
  });

  it('records the route TEMPLATE, the method and the status, once', async () => {
    const { interceptor, context, record } = setup();

    await firstValueFrom(interceptor.intercept(context, { handle: () => of({}) }));

    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ route: '/v1/assets/:id', method: 'GET', statusCode: 200 }),
    );
  });

  it('falls back to a normalised path when no route matched, never the raw URL with an id in it', async () => {
    const { interceptor, context, record } = setup({ routeUrl: undefined });
    (context as unknown as { switchToHttp: () => { getRequest: () => Record<string, unknown> } })
      .switchToHttp()
      .getRequest()['routeOptions'] = undefined;

    await firstValueFrom(interceptor.intercept(context, { handle: () => of({}) }));

    const route = (record.mock.calls[0]?.[0] as { route: string }).route;
    expect(route).not.toContain('019f8a00');
    expect(route).not.toContain('?');
  });

  it('counts a streaming handler ONCE, not once per value', async () => {
    const { interceptor, context, record } = setup();

    await lastValueFrom(interceptor.intercept(context, { handle: () => from([1, 2, 3]) }));

    expect(record).toHaveBeenCalledTimes(1);
  });

  it("takes a thrown DomainException's own status and error code: a 404 is a 404, not a 5xx", async () => {
    const { interceptor, context, record } = setup();

    await expect(
      firstValueFrom(
        interceptor.intercept(context, {
          handle: () => throwError(() => new NotFoundException('ASSET_NOT_FOUND', 'no such asset')),
        }),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 404, errorCode: 'ASSET_NOT_FOUND' }),
    );
  });

  it('logs the address from clientIp(): cf-connecting-ip, never x-real-ip', async () => {
    const { interceptor, context, log } = setup({ ip: '203.0.113.7' });

    await firstValueFrom(interceptor.intercept(context, { handle: () => of({}) }));

    expect(log).toHaveBeenCalledWith(expect.objectContaining({ ip: '203.0.113.7' }));
  });

  it('logs ONLY the URL length for a bridged MCP request, never the search terms it carries', async () => {
    const { interceptor, context, log } = setup({
      url: '/v1/employees?search=janedoe-secret-term&limit=20',
      bridged: true,
    });

    await firstValueFrom(interceptor.intercept(context, { handle: () => of({}) }));

    const line = log.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(line['url']).toBeUndefined();
    expect(line['urlLength']).toBe('/v1/employees?search=janedoe-secret-term&limit=20'.length);
    expect(JSON.stringify(line)).not.toContain('janedoe-secret-term');
  });

  it('does not log or record a probe path', async () => {
    const { interceptor, context, record, log } = setup({ url: '/v1/healthz' });

    await firstValueFrom(interceptor.intercept(context, { handle: () => of({}) }));

    expect(record).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});
