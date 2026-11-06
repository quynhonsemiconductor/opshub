import { describe, expect, it } from 'vitest';
import { arrayResult, decodeOffset, encodeOffset, listResult, pageQuery } from './rest';

/** The cursor is opaque to clients, so the only contract is round-trip + bomb-proofing. */
describe('MCP list plumbing', () => {
  it('round-trips an offset through the opaque cursor', () => {
    expect(decodeOffset(encodeOffset(0))).toBe(0);
    expect(decodeOffset(encodeOffset(40))).toBe(40);
    expect(pageQuery(undefined, encodeOffset(40))).toEqual({ limit: 20, offset: 40 });
  });

  it('a malformed cursor starts from the first page, never fails the read', () => {
    for (const cursor of ['not-base64-!!', '////', ' ', 'eA']) {
      expect(decodeOffset(cursor)).toBe(0);
    }
  });

  it('an encoded over-cap or negative offset is refused rather than scanning', () => {
    expect(decodeOffset(encodeOffset(1_000_001))).toBe(0);
    expect(decodeOffset(Buffer.from('-5').toString('base64url'))).toBe(0);
    expect(decodeOffset(Buffer.from('1e9').toString('base64url'))).toBe(0);
  });

  it('a 4xx is relayed unchanged; a 2xx with the wrong shape is 502, never an empty list', () => {
    const denied = listResult(403, { message: 'no' }, (r) => r, 'rows', { offset: 0, limit: 20 });
    expect(JSON.parse(denied.content[0].text)).toEqual({
      statusCode: 403,
      error: { message: 'no' },
    });

    const drift = listResult(200, { not: 'a list' }, (r) => r, 'rows', { offset: 0, limit: 20 });
    expect('isError' in drift && drift.isError).toBe(true);
    expect((JSON.parse(drift.content[0].text) as { statusCode: number }).statusCode).toBe(502);
  });

  it('slices a bare-array feed and reports its own cursor', () => {
    const out = arrayResult(
      200,
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      (r) => ({ id: r['id'] }),
      'rows',
      { offset: 0, limit: 2 },
    );
    const body = JSON.parse(out.content[0].text) as {
      rows: unknown[];
      pageInfo: { total: number; hasNextPage: boolean; nextCursor: string | null };
    };
    expect(body.rows).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(body.pageInfo).toMatchObject({
      total: 3,
      hasNextPage: true,
      nextCursor: encodeOffset(2),
    });

    const drift = arrayResult(200, { not: 'array' }, (r) => r, 'rows', { offset: 0, limit: 2 });
    expect((JSON.parse(drift.content[0].text) as { statusCode: number }).statusCode).toBe(502);
  });

  it('maps a paged body and reports the next cursor only when there is a next page', () => {
    const out = listResult(
      200,
      { data: [{ id: 'a' }], pageInfo: { total: 2, hasNextPage: true } },
      (r) => ({ id: r['id'] }),
      'rows',
      { offset: 0, limit: 1 },
    );
    const body = JSON.parse(out.content[0].text) as {
      rows: unknown[];
      pageInfo: { total: number; nextCursor: string | null };
    };
    expect(body.rows).toEqual([{ id: 'a' }]);
    expect(body.pageInfo).toMatchObject({ total: 2, nextCursor: encodeOffset(1) });

    const last = listResult(
      200,
      { data: [], pageInfo: { total: 1, hasNextPage: false } },
      (r) => r,
      'rows',
      { offset: 1, limit: 1 },
    );
    expect(
      (JSON.parse(last.content[0].text) as { pageInfo: { nextCursor: unknown } }).pageInfo
        .nextCursor,
    ).toBeNull();
  });
});
