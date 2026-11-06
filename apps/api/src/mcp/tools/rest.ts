import { z } from 'zod';
import type { McpPrincipalContext } from '@platform/mcp-call-token';

/**
 * The plumbing shared by every MCP tool (MCP-PLAN §4/§11): tools reach opshub ONLY through
 * in-process REST (`inject()` with the person as principal) — the HTTP layer is the authorization
 * point. One file per tool beside this one; `registry.ts` names every tool's REST route for the
 * ratchet; `register.ts` mounts them all.
 */

/** One in-process REST call a tool composes. No headers, ever — see the ratchet. */
export interface McpRestCall {
  method: 'GET';
  url: string;
  query?: Record<string, string | number | boolean | undefined>;
}

export interface McpRestResult {
  statusCode: number;
  json: unknown;
}

/** Runs one call through `app.inject()` with the tool request's principal (built in route.ts). */
export type McpRestCaller = (
  principal: McpPrincipalContext,
  call: McpRestCall,
) => Promise<McpRestResult>;

/** What register.ts hands every tool: the request's ONE principal and the caller. */
export interface ToolContext {
  principal: McpPrincipalContext;
  callRest: McpRestCaller;
}

/** Tools cap the page below the REST max: an agent re-asks with a cursor rather than reading 100 rows. */
export const MCP_TOOL_PAGE_LIMIT = 20;

/** Shared list-tool page args: `limit` + `cursor` (MCP-PLAN §11). */
export const pageArgs = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(MCP_TOOL_PAGE_LIMIT)
    .optional()
    .describe(`Page size (default ${MCP_TOOL_PAGE_LIMIT})`),
  cursor: z.string().optional().describe('Opaque cursor from the previous page'),
};

/**
 * Opshub's REST lists are offset-paged, and MCP-PLAN §11 requires `limit` + `cursor` on every
 * list tool. The cursor is therefore an opaque encoding of the offset: clients never see or
 * construct one, and a future move of the REST side to cursor pagination changes only this file.
 */
export function pageQuery(
  limit: number | undefined,
  cursor: string | undefined,
): { limit: number; offset: number } {
  return { limit: limit ?? MCP_TOOL_PAGE_LIMIT, offset: decodeOffset(cursor) };
}

export function encodeOffset(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

/** A cursor past any honest page is treated like a malformed one: start over, never scan. */
const MAX_CURSOR_OFFSET = 1_000_000;

/**
 * A malformed or unknown cursor starts from the first page rather than failing a read.
 * `Buffer.from(…, 'base64url')` never throws on bad input (it drops invalid characters), so the
 * only guard needed is the decoded value: a finite, non-negative integer within the cap.
 */
export function decodeOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  const decoded = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
  return Number.isInteger(decoded) && decoded >= 0 && decoded <= MAX_CURSOR_OFFSET ? decoded : 0;
}

/** Passes a REST denial through unchanged: the same status and body the person's REST call gets. */
export function denied(statusCode: number, json: unknown) {
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: JSON.stringify({ statusCode, error: json }) }],
  };
}

/** Wraps a single-record tool result: denial pass-through, else a small JSON payload. */
export function result(statusCode: number, json: unknown, payload: unknown) {
  if (statusCode >= 400) return denied(statusCode, json);
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

/** What a list result reports back to the agent. */
interface PageInfo {
  total: number | null;
  hasNextPage: boolean;
  nextCursor: string | null;
}

function pageInfoOf(json: unknown, offset: number, limit: number, rowCount: number): PageInfo {
  const page = (json as { pageInfo?: Record<string, unknown> } | null)?.pageInfo;
  const total = typeof page?.['total'] === 'number' ? page['total'] : null;
  let hasNextPage = false;
  if (typeof page?.['hasNextPage'] === 'boolean') hasNextPage = page['hasNextPage'];
  else if (total !== null) hasNextPage = offset + rowCount < total;
  return {
    total,
    hasNextPage,
    nextCursor: hasNextPage ? encodeOffset(offset + rowCount) : null,
  };
}

/**
 * Wraps a LIST tool result. The denial check happens BEFORE any shaping: on a 403/404 the REST
 * body is an error OBJECT, and mapping it as an array would throw `x.map is not a function`
 * straight to the client. A non-array success body (contract drift) is relayed, not shaped.
 */
export function listResult(
  statusCode: number,
  json: unknown,
  mapItem: (item: Record<string, unknown>) => Record<string, unknown>,
  listKey: string,
  page: { offset: number; limit: number },
) {
  if (statusCode >= 400) return denied(statusCode, json);
  const rows = Array.isArray(json) ? json : (json as { data?: unknown } | null)?.data;
  // A 2xx that is not the documented shape is contract drift: surface it as an upstream failure,
  // never as a successful empty list.
  if (!Array.isArray(rows)) return denied(502, json);
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          [listKey]: rows.map((row) => mapItem(row as Record<string, unknown>)),
          pageInfo: pageInfoOf(json, page.offset, page.limit, rows.length),
        }),
      },
    ],
  };
}
