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
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CacheService } from '@quynhonsemiconductor/platform-cache';
import { DRIZZLE, type DrizzleDB } from '@platform';
import { employees, session as identitySession, user as identityUser } from '../../db/schema';
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
let db: DrizzleDB;

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
  db = app.get<DrizzleDB>(DRIZZLE);
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

describe('offboarding while the session cache (Valkey) is down', () => {
  /*
   * THE FAILURE THIS GUARDS. The ban used to run only AFTER the status committed, through identity's
   * `setUserBanned`, which REFUSES while Valkey is unavailable (SessionStoreUnavailableError) before changing
   * anything. With Valkey down the status committed and nothing else did: the leaver was `offboarded` but not
   * banned, their sessions were still served from Postgres, and they could sign in again. A retry did nothing,
   * because the status already matched. So the ban and the session rows are now written in the status
   * transaction, and the call that needs Valkey only clears its cached copies.
   */
  async function withCacheDown<T>(run: () => Promise<T>): Promise<T> {
    const cache = app.get(CacheService);
    const down = vi.spyOn(cache, 'isAvailable', 'get').mockReturnValue(false);
    try {
      return await run();
    } finally {
      down.mockRestore();
    }
  }

  async function userRow(id: string) {
    const [row] = await db
      .select({ banned: identityUser.banned })
      .from(identityUser)
      .where(eq(identityUser.id, id));
    return row;
  }

  async function sessionRows(id: string): Promise<number> {
    return (await db.select().from(identitySession).where(eq(identitySession.userId, id))).length;
  }

  async function patchStatus(id: string, status: string) {
    return app.inject({
      method: 'PATCH',
      url: `/v1/employees/${id}/status`,
      headers: authHeaders(admin),
      payload: { status },
    });
  }

  it('still bans the user and deletes the sessions; the leaver cannot use or renew them', async () => {
    const employee = await throwaway();
    const session = await login(app, employee);
    expect(await meWithCookie(session.cookieHeader), 'the cookie did not work even before').toBe(
      200,
    );
    expect(await sessionRows(employee.id)).toBeGreaterThan(0);

    const res = await withCacheDown(() => patchStatus(employee.id, 'offboarded'));

    // The cache half could not run, so the request reports the failure ...
    expect(res.statusCode, res.body).toBeGreaterThanOrEqual(500);
    // ... but the authoritative half committed with the status: banned, no session rows.
    expect((await userRow(employee.id))?.banned, 'the leaver was left unbanned').toBe(true);
    expect(await sessionRows(employee.id), 'the leaver kept session rows').toBe(0);
    const [emp] = await db.select().from(employees).where(eq(employees.id, employee.id));
    expect(emp?.status).toBe('offboarded');

    // Valkey is back. A new sign-in is refused. (The OLD cookie is not asserted here: a copy cached in Valkey
    // can be believed for up to 30 s by a process that last saw the user unbanned, until the retry below
    // clears it. That bounded window is the price of Valkey being down, and identity documents it.)
    const again = await app.inject({
      method: 'POST',
      url: '/api/auth/test-login',
      payload: { email: employee.email },
    });
    expect(again.statusCode, again.body).toBe(403);
    expect(again.json<{ code?: string }>().code).toBe('BANNED_USER');
  });

  it('a retry is not a no-op: it finishes the job once the cache is back', async () => {
    const employee = await throwaway();
    const session = await login(app, employee);
    expect(await meWithCookie(session.cookieHeader)).toBe(200); // cached in Valkey, and believed unbanned
    const failed = await withCacheDown(() => patchStatus(employee.id, 'offboarded'));
    expect(failed.statusCode).toBeGreaterThanOrEqual(500);

    // offboarded → offboarded, cache healthy: the ban and the cache clear are re-applied, and it succeeds.
    const retried = await patchStatus(employee.id, 'offboarded');

    expect(retried.statusCode, retried.body).toBe(200);
    expect((await userRow(employee.id))?.banned).toBe(true);
    expect(await sessionRows(employee.id)).toBe(0);
    // and the cached copy of the old session is gone, at once (the retry cleared it and the ban memory)
    expect(
      await meWithCookie(session.cookieHeader),
      'the retry left the leaver’s cached session alive',
    ).toBe(401);
  });

  it('re-activating lifts the ban (and needs no cache), and the person can sign in again', async () => {
    const employee = await throwaway();
    await offboard(employee.id);
    expect((await userRow(employee.id))?.banned).toBe(true);

    const res = await withCacheDown(() => patchStatus(employee.id, 'active'));

    expect(res.statusCode, res.body).toBe(200);
    expect((await userRow(employee.id))?.banned).toBe(false);
    const session = await login(app, employee);
    expect(await meWithCookie(session.cookieHeader)).toBe(200);
  });

  it('on_leave also lifts the ban: that person may sign in', async () => {
    const employee = await throwaway();
    await offboard(employee.id);

    const res = await patchStatus(employee.id, 'on_leave');

    expect(res.statusCode, res.body).toBe(200);
    expect((await userRow(employee.id))?.banned).toBe(false);
  });
});
