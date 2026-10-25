import { describe, expect, it, vi } from 'vitest';
import { EDGE_SIG_HEADER } from '@quynhonsemiconductor/platform-http/edge';
import { onRequest } from './[[path]]';

const env = {
  API_ORIGIN: 'https://opshub-api-dev.qnsc.vn',
  EDGE_CLIENT_IP_SECRET: 'e'.repeat(40),
};

/**
 * identity 8's surface (`/api/auth/*`) goes through the same proxy as `/v1/*`: the Microsoft callback is
 * registered on the SPA host as the Entra redirect URI, and the session cookie it sets must come from that host.
 */
describe('Pages Function /api/auth/*', () => {
  it('forwards the sign-in start to the API origin, signed, keeping the Origin Better Auth checks', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response('{"url":"https://login.example/authorize"}', { status: 200 }),
      );
    const request = new Request('https://opshub-dev.qnsc.vn/api/auth/sign-in/social', {
      method: 'POST',
      headers: {
        origin: 'https://opshub-dev.qnsc.vn',
        'content-type': 'application/json',
        'cf-connecting-ip': '203.0.113.7',
      },
      body: '{"provider":"microsoft","callbackURL":"/"}',
    });

    const res = await onRequest({ request, env });

    expect(res.status).toBe(200);
    const forwarded = fetchSpy.mock.calls[0]?.[0] as Request;
    expect(forwarded.url).toBe('https://opshub-api-dev.qnsc.vn/api/auth/sign-in/social');
    expect(forwarded.method).toBe('POST');
    expect(forwarded.headers.get('origin')).toBe('https://opshub-dev.qnsc.vn');
    expect(forwarded.headers.get(EDGE_SIG_HEADER)).toBeTruthy();
    fetchSpy.mockRestore();
  });

  it('passes the callback redirect and the session cookie back to the browser untouched', async () => {
    const upstream = new Response(null, { status: 302, headers: { location: '/' } });
    upstream.headers.append(
      'set-cookie',
      '__Secure-opshub.session_token=abc; Path=/; HttpOnly; Secure',
    );
    upstream.headers.append('set-cookie', '__Secure-opshub.state=; Path=/; Max-Age=0');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(upstream);
    const request = new Request(
      'https://opshub-dev.qnsc.vn/api/auth/callback/microsoft?code=c&state=s',
      { headers: { 'cf-connecting-ip': '203.0.113.7' } },
    );

    const res = await onRequest({ request, env });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    expect(res.headers.getSetCookie()).toHaveLength(2);
    expect((fetchSpy.mock.calls[0]?.[0] as Request).url).toBe(
      'https://opshub-api-dev.qnsc.vn/api/auth/callback/microsoft?code=c&state=s',
    );
    fetchSpy.mockRestore();
  });

  it('fails loudly when API_ORIGIN or the edge secret is not configured', async () => {
    const request = new Request('https://opshub-dev.qnsc.vn/api/auth/sign-out', { method: 'POST' });
    expect((await onRequest({ request, env: {} })).status).toBe(500);
    expect((await onRequest({ request, env: { API_ORIGIN: env.API_ORIGIN } })).status).toBe(500);
  });
});
