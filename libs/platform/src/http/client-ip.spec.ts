/**
 * `clientIp()` with NO `EDGE_CLIENT_IP_SECRET` — the on-prem configuration.
 *
 * The signed edge address is an UPGRADE, not the source of truth. On the same-origin on-prem host there is no
 * Pages Function in front of the API: Cloudflare's tunnel still sets `cf-connecting-ip` at its edge, and every
 * request must key its rate-limit bucket and access-log line on that address. Requiring the signing key in
 * production crash-looped the pod; this file pins the fallback that makes the key optional.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertEdgeClientIpEnv, clientIp } from '@quynhonsemiconductor/platform-http';

const KEYS = ['EDGE_CLIENT_IP_SECRET', 'EDGE_CLIENT_IP_SECRET_PREVIOUS'] as const;
const saved: Record<string, string | undefined> = {};

/** The slice of a Fastify request `clientIp()` reads. */
function request(headers: Record<string, string>, remoteAddress = '10.0.0.9') {
  return { headers, socket: { remoteAddress } } as never;
}

describe('clientIp() with no signed-edge key', () => {
  beforeEach(() => {
    for (const key of KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('falls back to cf-connecting-ip, the address Cloudflare sets at the tunnel edge', () => {
    expect(clientIp(request({ 'cf-connecting-ip': '203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('prefers cf-connecting-ip over a caller-controlled x-forwarded-for', () => {
    expect(
      clientIp(request({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.99' })),
    ).toBe('203.0.113.7');
  });

  it('boots without the key: an absent secret is OFF, not a configuration error', () => {
    expect(() => assertEdgeClientIpEnv()).not.toThrow();
  });

  it('still refuses PREVIOUS without a current key (the rotation guard is unchanged)', () => {
    process.env['EDGE_CLIENT_IP_SECRET_PREVIOUS'] = 'p'.repeat(40);
    expect(() => assertEdgeClientIpEnv()).toThrow(/EDGE_CLIENT_IP_SECRET_PREVIOUS is set/);
  });
});
