/**
 * End-to-end proof that CSRF protection is actually ENFORCED.
 *
 * `libs/platform/src/http/csrf.spec.ts` already tests `requiresCsrfProtection` as a pure
 * function, and thoroughly. What it cannot test is whether anything CALLS it: the policy is
 * attached by a single `onRequest` hook in `bootstrapApp`, and registering
 * `@fastify/csrf-protection` only decorates `reply.generateCsrf()` and `app.csrfProtection`
 * — it enforces NOTHING until that hook attaches it. rova shipped exactly that defect: the
 * plugin registered, the hook never wired, no token ever issued, and the only thing actually
 * stopping a cross-site request was `SameSite=Strict` on the session cookie. A single
 * control a future cookie tweak could silently remove, with no test failing.
 *
 * So these specs assert the wiring, not the policy: that a token is issued, that omitting it
 * fails, that presenting it succeeds, that it is bound to the session that requested it, and
 * that the deliberate exemptions still work. They go through `createTestApp()`, which calls
 * the same `bootstrapApp` as production — a spec that assembled its own Nest app would prove
 * nothing here, because the hook it is testing lives in the part it skipped.
 *
 * opshub differs from rova in where the token comes from: there is no `/v1/bff/me`. The token is minted
 * by `GET /v1/auth/me`, bound to the identity 8 session cookie it was requested with. The cookie is the
 * only credential there is (no Bearer path survives the move to identity 8), so every authenticated
 * state-changing request is subject to the gate; `/api/auth/*` is exempt, because sign-in runs before any
 * session exists and Better Auth checks the Origin of its own writes.
 *
 * The state-changing probe is `PATCH /v1/notifications/read-all`: authenticated, idempotent, and harmless.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d` and `pnpm db:seed`.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_SECRET_COOKIE } from '@platform';
import { FIXTURE, createTestApp, login, readCookie, signInCookie } from './support/harness';

const WRITE = { method: 'PATCH', url: '/v1/notifications/read-all' } as const;

let app: NestFastifyApplication;

beforeAll(async () => {
  app = await createTestApp();
}, 60_000);

afterAll(async () => {
  await app?.close();
});

describe('CSRF protection is enforced', () => {
  it('issues a session-bound token and the signed secret cookie from /v1/auth/me', async () => {
    const { sessionCookie } = await signInCookie(app, FIXTURE.NO_PERMISSIONS);
    const me = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie: sessionCookie },
    });

    expect(me.statusCode, me.body).toBe(200);
    expect(
      readCookie(me.headers['set-cookie'], CSRF_SECRET_COOKIE),
      'no CSRF secret cookie',
    ).toBeDefined();
    expect(me.json<{ csrfToken?: string }>().csrfToken).toBeTruthy();
  });

  // The assertion that would have caught rova's defect: without the hook this is a 204.
  it('rejects a cookie-authenticated write with no CSRF token', async () => {
    const session = await login(app, FIXTURE.NO_PERMISSIONS);
    const res = await app.inject({ ...WRITE, headers: { cookie: session.cookieHeader } });
    expect(res.statusCode).toBe(403);
  });

  // The other direction — otherwise the 403 above is also satisfied by a route that is
  // simply broken, or by a CSRF gate that rejects everything.
  it('accepts the same write when the token is presented', async () => {
    const session = await login(app, FIXTURE.NO_PERMISSIONS);
    const res = await app.inject({
      ...WRITE,
      headers: { cookie: session.cookieHeader, 'x-csrf-token': session.csrfToken },
    });
    expect(res.statusCode, res.body).toBe(204);
  });

  it("rejects another session's token", async () => {
    // The replay shape an attacker actually has: a token lifted from a different session,
    // presented against this one. (Each session gets its own secret cookie, so the pair mismatches on the
    // secret before the session binding is even consulted; the outcome is what must hold.)
    const victim = await login(app, FIXTURE.NO_PERMISSIONS);
    const attacker = await login(app, FIXTURE.NO_PERMISSIONS);
    const res = await app.inject({
      ...WRITE,
      headers: { cookie: victim.cookieHeader, 'x-csrf-token': attacker.csrfToken },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a garbage token', async () => {
    const session = await login(app, FIXTURE.NO_PERMISSIONS);
    const res = await app.inject({
      ...WRITE,
      headers: { cookie: session.cookieHeader, 'x-csrf-token': 'not-a-real-token' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a token presented WITHOUT the secret cookie', async () => {
    // Double-submit needs both halves. A token alone — the half an attacker's page could
    // plausibly obtain — must not authorize anything.
    const session = await login(app, FIXTURE.NO_PERMISSIONS);
    const res = await app.inject({
      ...WRITE,
      headers: { cookie: session.sessionCookie, 'x-csrf-token': session.csrfToken },
    });
    expect(res.statusCode).toBe(403);
  });

  it('does not accept the token from the request body', async () => {
    // A token an attacker can plant in a form post must not authorize anything. Two independent controls
    // produce this (the header-only `getToken`, and the gate being an `onRequest` hook that runs before
    // body parsing); this pins the OUTCOME, which must hold whichever of them is simplified away.
    const session = await login(app, FIXTURE.NO_PERMISSIONS);
    const res = await app.inject({
      ...WRITE,
      headers: { cookie: session.cookieHeader },
      payload: { _csrf: session.csrfToken },
    });
    expect(res.statusCode).toBe(403);
  });

  it('does not require a token on a safe method', async () => {
    const session = await login(app, FIXTURE.NO_PERMISSIONS);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie: session.cookieHeader },
    });
    expect(res.statusCode).toBe(200);
  });

  it('exempts identity’s own routes, which run before any session exists', async () => {
    // A CSRF 403 here would make signing in impossible for a returning user still holding an expired
    // session cookie: they would send an ambient credential to the one route that cannot issue a token yet.
    // With no Origin header the request IS refused, by BETTER AUTH's own origin check on its writes: the
    // control that stands in for the double-submit token on this surface. That refusal, not ours, is what
    // proves the request got past our gate.
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/test-login',
      headers: { cookie: '__Secure-opshub.session_token=expired.cookie' },
      payload: { email: FIXTURE.NO_PERMISSIONS.email },
    });
    expect(res.json<{ code?: string }>().code).toBe('MISSING_OR_NULL_ORIGIN');
    expect(res.body).not.toMatch(/csrf/i);
  });

  it('gives a Bearer header no standing: there is no such credential any more', async () => {
    // A bogus Bearer fails AUTH (401), and is not mistaken for a machine-client exemption.
    const res = await app.inject({
      ...WRITE,
      headers: { authorization: 'Bearer not.a.real.token' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.body.toLowerCase()).not.toContain('csrf');
  });

  it('does not gate a request that carries no ambient credential at all', async () => {
    // With no session cookie there is nothing to forge, so the CSRF gate must not fire —
    // otherwise every unauthenticated write would 403 instead of 401, and the API would
    // report "forbidden" to callers who simply had not signed in.
    const res = await app.inject({ ...WRITE });
    expect(res.statusCode).toBe(401);
  });
});
