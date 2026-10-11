/**
 * Offboarding stops an ALREADY-ISSUED session, and refuses a new one.
 *
 * `EmployeeService.updateStatus` calls `SessionRevoker.offboard` once the status change has committed.
 * That is `setUserBanned(auth, id, true)`: the user is flagged banned, every session row is deleted, and
 * identity's session cache is cleared. Identity's `SessionGuard` then refuses the cookie on its next read.
 * Nothing exercised that path end to end:
 *
 *   - `offboarding-revocation.e2e.spec.ts` proves the removals are AUDITED. It never presents a credential
 *     afterwards.
 *   - `authz-revocation.e2e.spec.ts` proves a REVOKED PERMISSION takes effect on the same session, and
 *     says so: a 403, because the session is still perfectly valid. A different mechanism.
 *
 * So the gap was exact: a leaver's live session being refused was the one thing nobody asked for. Without
 * this, a refactor that dropped `offboard` from the status change would extend a leaver's access from
 * milliseconds to the 12 h session lifetime with every test still green.
 *
 * ONE credential now, the session cookie. v7 had two paths (Bearer token and BFF cookie) and a denylist
 * for each; the SPA was always the one that mattered, and it is the only path left.
 *
 * THROWAWAY EMPLOYEES, NEVER FIXTURES. Offboarding a fixture bans it for every spec that runs afterwards,
 * which is the cross-spec pollution that made `performance.e2e.spec.ts` fail on a database other suites
 * had already touched.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d`, `pnpm db:migrate`, `pnpm db:seed`.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FIXTURE,
  authHeaders,
  createTestApp,
  login,
  unwrap,
  type Session,
} from './support/harness';

let app: NestFastifyApplication;
let admin: Session;

const RUN = Date.now().toString(36).toUpperCase().slice(-6);
let seq = 0;

interface EmployeeRow {
  id: string;
  email: string;
}

/** A fresh employee nobody else's spec depends on. */
async function throwaway(): Promise<EmployeeRow> {
  const email = `revoke.${RUN}.${++seq}@opshub.local`;
  const res = await app.inject({
    method: 'POST',
    url: '/v1/employees',
    headers: authHeaders(admin),
    payload: { email, displayName: `Revocation probe ${seq}`, roles: ['employee'] },
  });
  expect(res.statusCode, res.body).toBe(201);
  return unwrap<EmployeeRow>(JSON.parse(res.body));
}

async function offboard(id: string): Promise<void> {
  const res = await app.inject({
    method: 'PATCH',
    url: `/v1/employees/${id}/status`,
    headers: authHeaders(admin),
    payload: { status: 'offboarded' },
  });
  expect(res.statusCode, res.body).toBe(200);
}

/** `GET /auth/me` with a session cookie — the SPA's only path. */
async function meWithCookie(cookieHeader: string): Promise<number> {
  const res = await app.inject({
    method: 'GET',
    url: '/v1/auth/me',
    headers: { cookie: cookieHeader },
  });
  return res.statusCode;
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await login(app, FIXTURE.ADMIN);
});

afterAll(async () => {
  await app?.close();
});

describe('fast revocation on offboarding', () => {
  it('refuses a session cookie issued before the offboarding', async () => {
    const employee = await throwaway();
    const session = await login(app, employee);

    /*
     * ASSERTED BEFORE AS WELL AS AFTER. Without the "before", a cookie that never worked would produce the
     * same 401 and read as revocation working.
     */
    expect(await meWithCookie(session.cookieHeader), 'the cookie did not work even before').toBe(
      200,
    );

    await offboard(employee.id);

    // The SAME cookie. Not a fresh login, which would be refused for a different reason entirely.
    expect(
      await meWithCookie(session.cookieHeader),
      'an offboarded employee kept a live browser session, so offboarding is inert for the SPA',
    ).toBe(401);
  });

  it('refuses a NEW sign-in for an offboarded employee', async () => {
    /*
     * The ban, as opposed to the deletion of the rows that existed. Deleting sessions alone ends today's;
     * the next Microsoft sign-in (or here, test-login) would mint another. Identity refuses a banned user
     * at sign-in with BANNED_USER, so the leaver cannot simply sign in again while Entra still lets them.
     */
    const employee = await throwaway();
    await offboard(employee.id);

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/test-login',
      payload: { email: employee.email },
    });

    expect(res.statusCode, res.body).toBe(403);
    expect(res.json<{ code?: string }>().code).toBe('BANNED_USER');
    expect(res.headers['set-cookie'], 'a banned user was handed a session cookie').toBeUndefined();
  });

  it('leaves everybody else signed in', async () => {
    /*
     * The blast radius. A ban keyed too broadly would sign the whole company out on any offboarding — a
     * failure the tests above cannot see, because they only ever ask about the person who was offboarded.
     */
    const [leaver, colleague] = [await throwaway(), await throwaway()];
    const colleagueSession = await login(app, colleague);
    expect(await meWithCookie(colleagueSession.cookieHeader)).toBe(200);

    await offboard(leaver.id);

    expect(
      await meWithCookie(colleagueSession.cookieHeader),
      'offboarding one employee ended another’s session',
    ).toBe(200);
  });

  it('lets a reactivated employee back in', async () => {
    /*
     * `updateStatus` calls `SessionRevoker.reinstate` (`setUserBanned(false)`) when the status leaves
     * `offboarded`. Without it an offboarding reversed by mistake would lock the person out for good with
     * nothing in the product explaining why — and a NEW sign-in would not help, because the ban is on the
     * user rather than on a session.
     */
    const employee = await throwaway();
    await offboard(employee.id);

    const reinstate = await app.inject({
      method: 'PATCH',
      url: `/v1/employees/${employee.id}/status`,
      headers: authHeaders(admin),
      payload: { status: 'active' },
    });
    expect(reinstate.statusCode, reinstate.body).toBe(200);

    // A fresh sign-in, because the point is that a reinstated employee can work again — not that an old
    // session comes back to life, which it must not.
    const session = await login(app, employee);
    expect(
      await meWithCookie(session.cookieHeader),
      'a reinstated employee is still banned, so they cannot sign back in',
    ).toBe(200);
  });
});
