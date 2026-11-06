import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { registerWhoami } from './whoami';
import type { ToolContext } from './rest';

const ctx = (json: unknown, statusCode = 200): ToolContext => ({
  principal: { userId: 'u-1', email: 'jane@qnsc.vn', name: 'Jane', sessionId: 'mcp:1' },
  callRest: () => Promise.resolve({ statusCode, json }),
});

async function call(json: unknown, statusCode = 200) {
  const server = new McpServer({ name: 'spec', version: '0.0.0' });
  const tool = registerWhoami(server, ctx(json, statusCode));
  const handler = tool.handler as unknown as (
    args: unknown,
    extra: unknown,
  ) => Promise<{ isError?: boolean; content: { text: string }[] }>;
  return handler({}, {});
}

describe('opshub_whoami', () => {
  it('maps the documented identity shape', async () => {
    const out = await call({ sub: 'u-1', email: 'jane@qnsc.vn', name: 'Jane', roles: ['hr'] });
    expect(JSON.parse(out.content[0].text)).toEqual({
      id: 'u-1',
      email: 'jane@qnsc.vn',
      name: 'Jane',
      roles: ['hr'],
    });
  });

  it('a 4xx is relayed unchanged', async () => {
    const out = await call({ message: 'no' }, 403);
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content[0].text)).toEqual({ statusCode: 403, error: { message: 'no' } });
  });

  it('contract drift (2xx with a non-object body) is 502, never a 200 isError', async () => {
    for (const body of [null, 'text', ['array']]) {
      const out = await call(body);
      expect(out.isError).toBe(true);
      expect((JSON.parse(out.content[0].text) as { statusCode: number }).statusCode).toBe(502);
    }
  });
});
