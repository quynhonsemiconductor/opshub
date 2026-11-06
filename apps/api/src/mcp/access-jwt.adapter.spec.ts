import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import type { DrizzleDB } from '@platform';
import { createMcpAccessJwtAdapter, McpAccessDeniedError } from './access-jwt.adapter';

/**
 * The real access adapter against a REAL verifier and a REAL local JWKS server (identity's
 * `createAccessJwtVerifier` accepts a loopback http team domain exactly for this). Pins the P0
 * spike's constraints: full token verification (signature, iss, aud, exp) with one uniform 401
 * for any bad token; the employee resolved from the email — normalised, and only when not
 * offboarded — with unknown and offboarded failing the same 403; never auto-provisioned.
 */

const AUD = 'e2e-aud-tag';
const USER = '0194a000-0000-7000-8000-0000000000aa';
const TEAM = (port: number) => `http://127.0.0.1:${port}`;

type DbQueue = Array<Array<Record<string, unknown>>>;

/** Drizzle SQL nodes carry their bound values in (nested) `queryChunks`; pull them out. */
function paramsOf(node: unknown, out: unknown[] = []): unknown[] {
  const chunks = (node as { queryChunks?: unknown[] } | null)?.queryChunks;
  if (!chunks) return out;
  for (const chunk of chunks) {
    if (chunk && typeof chunk === 'object') {
      if ('value' in chunk) out.push(chunk.value);
      else paramsOf(chunk, out);
    }
  }
  return out;
}

/** A drizzle stand-in for the adapter's single employee select. */
function dbWith(queue: DbQueue) {
  const captured: unknown[][] = [];
  const db = {
    select: () => ({
      from: () => ({
        where: (where?: unknown) => ({
          limit: () => {
            captured.push(paramsOf(where));
            return Promise.resolve(queue.shift() ?? []);
          },
        }),
      }),
    }),
  };
  return { db: db as never as DrizzleDB, captured };
}

const logger = { warn: vi.fn() };

async function listen(
  jwks: Record<string, unknown>,
): Promise<{ server: http.Server; port: number }> {
  const server = http
    .createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(jwks));
    })
    .listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

/** RS256 minting key + its public JWK, served as the team JWKS under kid 'k1'. */
async function mintingKey(): Promise<{
  privateKey: CryptoKey;
  publicJwk: Record<string, unknown>;
}> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = { kid: 'k1', ...(await exportJWK(publicKey)) };
  return { privateKey, publicJwk };
}

interface MintArgs {
  privateKey: CryptoKey;
  team: string;
  sub?: string;
  email?: string;
  aud?: string;
  exp?: number;
}

async function mint(a: MintArgs): Promise<string> {
  return new SignJWT({ ...(a.email !== undefined ? { email: a.email } : {}) })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setSubject(a.sub ?? 'access-sub-1')
    .setIssuer(a.team)
    .setAudience(a.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime(a.exp ?? Math.floor(Date.now() / 1000) + 600)
    .setNotBefore(Math.floor(Date.now() / 1000) - 5)
    .sign(a.privateKey);
}

describe('McpAccessJwtAdapter', () => {
  it('maps a verified token to the employee by normalised email, excluding offboarded rows', async () => {
    const { privateKey, publicJwk } = await mintingKey();
    const { server, port } = await listen({ keys: [publicJwk] });
    try {
      const { db, captured } = dbWith([[{ id: USER, email: 'jane@qnsc.vn', name: 'Jane' }]]);
      const adapter = createMcpAccessJwtAdapter({
        db,
        teamDomain: TEAM(port),
        audience: AUD,
        logger: logger as never,
      });
      const out = await adapter.verify(
        await mint({ privateKey, team: TEAM(port), email: '  Jane@QNSC.vn ', sub: 'access-sub-1' }),
      );
      expect(out).toEqual({ userId: USER, email: 'jane@qnsc.vn', name: 'Jane' });
      // the status predicate is part of the lookup: an offboarded row never matches
      expect(JSON.stringify(captured[0])).toContain('offboarded');
    } finally {
      server.close();
    }
  });

  it('denies (403) an OFFBOARDED or unknown employee — logged as { accessSub, reason }, never the email', async () => {
    const { privateKey, publicJwk } = await mintingKey();
    const { server, port } = await listen({ keys: [publicJwk] });
    try {
      const { db } = dbWith([[]]); // the where clause (not offboarded, matching email) found nobody
      const adapter = createMcpAccessJwtAdapter({
        db,
        teamDomain: TEAM(port),
        audience: AUD,
        logger: logger as never,
      });
      await expect(
        adapter.verify(await mint({ privateKey, team: TEAM(port), email: 'gone@qnsc.vn' })),
      ).rejects.toThrow(McpAccessDeniedError);
      expect(logger.warn).toHaveBeenCalledWith(
        { accessSub: 'access-sub-1', reason: 'no_active_employee' },
        'MCP access denied',
      );
    } finally {
      server.close();
    }
  });

  it.each([
    ['wrong audience', { aud: 'another-apps-aud' }],
    ['expired', { exp: Math.floor(Date.now() / 1000) - 3600 }],
    ['wrong issuer', { team: 'https://someone-elses.cloudflareaccess.com' }],
  ])('answers one uniform 401 for a %s token', async (_name, overrides) => {
    const { privateKey, publicJwk } = await mintingKey();
    const { server, port } = await listen({ keys: [publicJwk] });
    try {
      const { db } = dbWith([]);
      const adapter = createMcpAccessJwtAdapter({
        db,
        teamDomain: TEAM(port),
        audience: AUD,
        logger: logger as never,
      });
      const token = await mint({
        privateKey,
        team: TEAM(port),
        email: 'jane@qnsc.vn',
        ...overrides,
      });
      expect(await adapter.verify(token)).toBeNull();
    } finally {
      server.close();
    }
  });

  it('answers 401 for a token signed by a key the team JWKS does not carry', async () => {
    const { publicJwk } = await mintingKey();
    const attacker = await mintingKey();
    const { server, port } = await listen({ keys: [publicJwk] });
    try {
      const { db } = dbWith([]);
      const adapter = createMcpAccessJwtAdapter({
        db,
        teamDomain: TEAM(port),
        audience: AUD,
        logger: logger as never,
      });
      const forged = await mint({
        privateKey: attacker.privateKey,
        team: TEAM(port),
        email: 'jane@qnsc.vn',
      });
      expect(await adapter.verify(forged)).toBeNull();
    } finally {
      server.close();
    }
  });

  it('a JWKS fetch failure is availability (thrown, a 5xx) — never a 401', async () => {
    // port 1 is nothing: the fetch cannot connect
    const { db } = dbWith([]);
    const adapter = createMcpAccessJwtAdapter({
      db,
      teamDomain: TEAM(1),
      audience: AUD,
      logger: logger as never,
    });
    const { privateKey } = await mintingKey();
    const token = await mint({ privateKey, team: TEAM(1), email: 'jane@qnsc.vn' });
    await expect(adapter.verify(token)).rejects.toMatchObject({ code: 'jwks_unavailable' });
  });
});
