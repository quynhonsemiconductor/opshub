import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * The cookie name is derived once, at import, from `NODE_ENV`: production issues `__Host-`, everything
 * else `__Secure-`. The CSRF gate, the auth controller and the API bootstrap all read THIS constant, so
 * the assertion pins the exact strings a browser must store for a session to work.
 */
describe('SESSION_COOKIE', () => {
  const original = process.env['NODE_ENV'];

  it('uses __Host- in production (a __Host- cookie is Secure, Path=/ and host-only)', async () => {
    process.env['NODE_ENV'] = 'production';
    vi.resetModules();
    const mod = await import('./session-cookie');
    expect(mod.HOST_COOKIES).toBe(true);
    expect(mod.SESSION_COOKIE).toBe('__Host-opshub.session_token');
  });

  it('keeps __Secure- outside production (local http, unit and e2e suites)', async () => {
    process.env['NODE_ENV'] = 'test';
    vi.resetModules();
    const mod = await import('./session-cookie');
    expect(mod.HOST_COOKIES).toBe(false);
    expect(mod.SESSION_COOKIE).toBe('__Secure-opshub.session_token');
  });

  afterAll(() => {
    process.env['NODE_ENV'] = original;
    vi.resetModules();
  });
});
