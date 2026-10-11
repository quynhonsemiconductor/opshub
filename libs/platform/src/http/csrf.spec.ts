import { describe, expect, it } from 'vitest';
import { CSRF_HEADER, requiresCsrfProtection } from './csrf';
import { SESSION_COOKIE } from '../auth/session-cookie';

/**
 * The CSRF policy, which is enforced by ONE `onRequest` hook rather than per route. That
 * makes this function the whole rule: if it returns false for a request that should be
 * checked, the route is silently unprotected, and nothing else in the system will say so.
 */

function req(overrides: Partial<Parameters<typeof requiresCsrfProtection>[0]> = {}) {
  return {
    method: 'POST',
    url: '/v1/assets',
    headers: {},
    cookies: { [SESSION_COOKIE]: 'token.signature' },
    ...overrides,
  };
}

describe('requiresCsrfProtection', () => {
  it('protects a cookie-authenticated write', () => {
    expect(requiresCsrfProtection(req())).toBe(true);
  });

  it.each(['GET', 'HEAD', 'OPTIONS', 'TRACE'])('skips %s — it cannot change state', (method) => {
    expect(requiresCsrfProtection(req({ method }))).toBe(false);
  });

  it('is case-insensitive about the method', () => {
    // Fastify normalises, but the policy must not depend on that.
    expect(requiresCsrfProtection(req({ method: 'get' }))).toBe(false);
    expect(requiresCsrfProtection(req({ method: 'post' }))).toBe(true);
  });

  it.each(['PUT', 'PATCH', 'DELETE'])('protects %s too, not just POST', (method) => {
    expect(requiresCsrfProtection(req({ method }))).toBe(true);
  });

  // There is no Bearer credential any more: the session cookie is the only way in, so an
  // Authorization header exempts nothing. (A request that carries both is judged by its cookie.)
  it('does NOT exempt a request because it carries an Authorization header', () => {
    expect(requiresCsrfProtection(req({ headers: { authorization: 'Bearer abc.def.ghi' } }))).toBe(
      true,
    );
    expect(requiresCsrfProtection(req({ headers: { authorization: 'Basic dXNlcjpwdw==' } }))).toBe(
      true,
    );
  });

  it('keys on identity 8’s session cookie, not v7’s', () => {
    expect(SESSION_COOKIE).toBe('__Secure-opshub.session_token');
    expect(requiresCsrfProtection(req({ cookies: { '__Host-opshub_session': 'sid-1' } }))).toBe(
      false,
    );
  });

  // With no ambient credential there is nothing to forge.
  it('skips a write with no session cookie', () => {
    expect(requiresCsrfProtection(req({ cookies: {} }))).toBe(false);
  });

  it('skips a write when cookies are absent entirely', () => {
    expect(requiresCsrfProtection(req({ cookies: undefined }))).toBe(false);
  });

  it('ignores unrelated cookies', () => {
    expect(requiresCsrfProtection(req({ cookies: { theme: 'dark' } }))).toBe(false);
  });

  describe('exempt routes', () => {
    it.each([
      // identity 8's own surface: sign-in runs BEFORE any session exists, so there is no token to issue,
      // and Better Auth enforces its own Origin check on every state-changing request there.
      '/api/auth/sign-in/social',
      '/api/auth/sign-out',
      '/api/auth/callback/microsoft',
    ])('exempts %s', (url) => {
      expect(requiresCsrfProtection(req({ url }))).toBe(false);
    });

    it('exempts a sub-path of an exempt route', () => {
      expect(requiresCsrfProtection(req({ url: '/api/auth/sign-in/social' }))).toBe(false);
    });

    it('exempts nothing under /v1: the webhook-receiver exemption is gone with the receiver that never existed', () => {
      expect(requiresCsrfProtection(req({ url: '/v1/webhooks/inbound' }))).toBe(true);
      expect(requiresCsrfProtection(req({ url: '/v1/webhooks/inbound/github' }))).toBe(true);
    });

    it('ignores the query string when matching', () => {
      expect(
        requiresCsrfProtection(req({ url: '/api/auth/callback/microsoft?code=x&state=y' })),
      ).toBe(false);
    });

    // The exemptions are anchored, not substring matches — otherwise a route could be
    // exempted by accident just by being named similarly.
    it('does not exempt a route that merely starts with the same characters', () => {
      expect(requiresCsrfProtection(req({ url: '/api/authority' }))).toBe(true);
    });

    it('does not exempt a route that only CONTAINS an exempt path', () => {
      expect(requiresCsrfProtection(req({ url: '/v1/admin/api/auth/sign-out' }))).toBe(true);
    });

    it('protects the v7 routes that no longer exist as exemptions', () => {
      expect(requiresCsrfProtection(req({ url: '/v1/bff/login' }))).toBe(true);
      expect(requiresCsrfProtection(req({ url: '/v1/auth/refresh' }))).toBe(true);
    });
  });

  it('names the header the SPA must echo', () => {
    // Pinned because the value appears in three places that must agree: this policy, the
    // plugin's getToken in the API bootstrap, and the CORS allow-list.
    expect(CSRF_HEADER).toBe('x-csrf-token');
  });
});
