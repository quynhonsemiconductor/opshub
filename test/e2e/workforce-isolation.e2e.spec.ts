/**
 * End-to-end proof that one employee cannot read another employee's HR records.
 *
 * This is the e2e counterpart to `workforce-access-narrowing.spec.ts`, and it exists
 * because that unit spec mocks the repository. It proves `narrowToActor` computes the
 * right FILTER; it cannot prove the filter reaches SQL, that the guard chain lets the
 * self-service caller through, or that the route wires the actor in at all. Those are the
 * three places the original bug actually lived — the controller never passed an actor.
 *
 * `route-policy.ratchet.spec.ts` cannot see any of this either: these six routes carry no
 * decorator and are still counted as unpoliced, deliberately. So this file is the only
 * check that runs the real guard chain, the real permission resolution and real SQL
 * against a real Postgres.
 *
 * Every assertion is made in BOTH directions. "Employee X gets a 403" is worth little on
 * its own — a route that is broken for everyone also produces it. Each case pairs the
 * denial with the same request succeeding for the tier that should be allowed.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d` and `pnpm db:seed`.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE, authHeaders, createTestApp, login, type Session } from './support/harness';

/** The four collections that share the optional-`employeeId` shape. */
const COLLECTIONS = [
  '/v1/workforce/timesheets',
  '/v1/workforce/leave',
  '/v1/workforce/overtime',
  '/v1/workforce/shifts',
] as const;

interface PagedBody {
  data: Array<{ employeeId: string }>;
  pageInfo: { total: number };
}

let app: NestFastifyApplication;
/** Holds the `employee` role, whose permission bundle is empty. */
let plain: Session;
/** Holds `workforce.read` + `workforce.approve` globally. */
let hr: Session;

beforeAll(async () => {
  app = await createTestApp();
  plain = await login(app, FIXTURE.NO_PERMISSIONS);
  hr = await login(app, FIXTURE.HR);
}, 60_000);

afterAll(async () => {
  await app?.close();
});

describe('workforce record isolation', () => {
  describe.each(COLLECTIONS)('GET %s', (url) => {
    // The request the SPA actually issues: no employeeId at all. Before the fix this
    // returned every employee's rows, which was both the leak and a functional bug.
    it('returns only the caller own rows when no filter is given', async () => {
      const res = await app.inject({ method: 'GET', url, headers: authHeaders(plain) });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as PagedBody;
      const foreign = body.data.filter((r) => r.employeeId !== FIXTURE.NO_PERMISSIONS.id);
      expect(foreign, `leaked rows: ${JSON.stringify(foreign)}`).toHaveLength(0);
    });

    it("403s a caller asking for another employee's records", async () => {
      const res = await app.inject({
        method: 'GET',
        url: `${url}?employeeId=${FIXTURE.HR.id}`,
        headers: authHeaders(plain),
      });
      expect(res.statusCode).toBe(403);
    });

    // The other direction, so the 403 above cannot be a route that is simply broken.
    it('lets a global workforce.read holder query any employee', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `${url}?employeeId=${FIXTURE.NO_PERMISSIONS.id}`,
        headers: authHeaders(hr),
      });
      expect(res.statusCode).toBe(200);
    });

    it('lets a caller name themselves explicitly', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `${url}?employeeId=${FIXTURE.NO_PERMISSIONS.id}`,
        headers: authHeaders(plain),
      });
      expect(res.statusCode).toBe(200);
    });

    it('still requires authentication', async () => {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(401);
    });
  });

  /**
   * The narrowing has to survive a caller trying to shake it off. These probe the two
   * type-confusion shapes that only a real HTTP request produces, and they document where
   * the defence actually sits: `ListTimesheetsQuerySchema` declares
   * `employeeId: z.string().uuid().optional()`, so the Zod pipe rejects both with a 422
   * BEFORE `narrowToActor` is reached.
   *
   * A 422 here is a stronger answer than the 403 these originally asserted, and worth
   * pinning precisely because it is upstream of the authorization code: if the schema is
   * ever loosened to plain `z.string()`, a repeated param arrives as an ARRAY, `!==`
   * against a string is trivially true, and the request would then be DENIED rather than
   * silently widened — but an array reaching SQL is its own hazard. These tests fail the
   * moment that boundary moves, in either direction.
   *
   * THEY SAID 400 UNTIL THE HARNESS WAS FIXED. `GlobalExceptionFilter` maps a Zod failure to 422,
   * but under vitest the app and the filter held two different `nestjs-zod` module instances, so
   * its `instanceof` missed and Nest's default 400 came back instead. 422 is what production has
   * always returned — see the `nestjs-zod` alias in `test/vitest.e2e.config.ts`.
   */
  describe('filter cannot be evaded', () => {
    it('rejects a repeated employeeId (array-valued query param) at validation', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/workforce/timesheets?employeeId=${FIXTURE.NO_PERMISSIONS.id}&employeeId=${FIXTURE.HR.id}`,
        headers: authHeaders(plain),
      });
      expect(res.statusCode).toBe(422);
    });

    it('rejects an empty employeeId rather than treating it as "no filter"', async () => {
      // `?employeeId=` arrives as `''`. The uuid check rejects it, so it can never reach
      // the falsy-check in `narrowToActor` and be read as "no constraint requested".
      const res = await app.inject({
        method: 'GET',
        url: '/v1/workforce/timesheets?employeeId=',
        headers: authHeaders(plain),
      });
      expect(res.statusCode).toBe(422);
    });

    it('ignores an employeeId supplied in the body of a GET', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/workforce/timesheets',
        headers: authHeaders(plain),
        payload: { employeeId: FIXTURE.HR.id },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as PagedBody;
      expect(body.data.every((r) => r.employeeId === FIXTURE.NO_PERMISSIONS.id)).toBe(true);
    });

    it('a well-formed but foreign uuid reaches authorization and is denied', async () => {
      // The complement of the two above: proves the 400s are a VALIDATION boundary, not the
      // authorization check quietly doing the work under a different status code.
      const res = await app.inject({
        method: 'GET',
        url: `/v1/workforce/timesheets?employeeId=${FIXTURE.HR.id}`,
        headers: authHeaders(plain),
      });
      expect(res.statusCode).toBe(403);
    });
  });

  /**
   * Self-service transitions. Both handlers used to take `_actor` and discard it, so these
   * assert the actor is now consulted — and that the 403 is decided BEFORE the state
   * machine, so the error cannot report another employee's record status back to a caller
   * who may not see it.
   */
  describe('self-service transitions', () => {
    let ownTimesheetId: string;

    beforeAll(async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/workforce/timesheets',
        headers: authHeaders(plain),
        payload: { workDate: '2026-08-03', minutesWorked: 480, note: 'e2e isolation fixture' },
      });
      expect(res.statusCode, res.body).toBe(201);
      ownTimesheetId = (JSON.parse(res.body) as { id: string }).id;
    });

    it('lets the owner submit their own timesheet', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/workforce/timesheets/${ownTimesheetId}/submit`,
        headers: authHeaders(plain),
      });
      expect(res.statusCode, res.body).toBe(201);
    });

    it("403s another employee submitting someone else's timesheet", async () => {
      // Created BY `plain`, submitted by a different principal. `hr` holds
      // `workforce.approve` globally so it is allowed on purpose — the denial has to come
      // from a caller holding neither ownership nor the permission, which is `admin`'s
      // opposite: use HR's own record and the plain employee as the actor.
      const hrTimesheet = await app.inject({
        method: 'POST',
        url: '/v1/workforce/timesheets',
        headers: authHeaders(hr),
        payload: { workDate: '2026-08-04', minutesWorked: 480, note: 'e2e foreign fixture' },
      });
      expect(hrTimesheet.statusCode, hrTimesheet.body).toBe(201);
      const foreignId = (JSON.parse(hrTimesheet.body) as { id: string }).id;

      const res = await app.inject({
        method: 'POST',
        url: `/v1/workforce/timesheets/${foreignId}/submit`,
        headers: authHeaders(plain),
      });
      expect(res.statusCode).toBe(403);
    });

    it('lets a global workforce.approve holder submit on an employee behalf', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/v1/workforce/timesheets',
        headers: authHeaders(plain),
        payload: { workDate: '2026-08-05', minutesWorked: 480, note: 'e2e hr-acts-for fixture' },
      });
      expect(created.statusCode, created.body).toBe(201);
      const id = (JSON.parse(created.body) as { id: string }).id;

      const res = await app.inject({
        method: 'POST',
        url: `/v1/workforce/timesheets/${id}/submit`,
        headers: authHeaders(hr),
      });
      expect(res.statusCode, res.body).toBe(201);
    });
  });

  /**
   * The avatar routes were fixed declaratively rather than in the service, so unlike
   * everything above they ARE visible to the ratchet. Asserted here anyway: the ratchet
   * only proves a decorator is present, never that it names a real permission or that the
   * scope descriptor resolves — a misspelled code reads as "policed" to a text scanner.
   */
  describe('employee avatar', () => {
    it('403s a caller with no employee.write on another employee avatar', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/employees/${FIXTURE.HR.id}/avatar/presign`,
        headers: authHeaders(plain),
        payload: { fileName: 'a.png', mimeType: 'image/png', sizeBytes: 1024 },
      });
      expect(res.statusCode).toBe(403);
    });

    it('lets an employee.write holder presign', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/employees/${FIXTURE.NO_PERMISSIONS.id}/avatar/presign`,
        headers: authHeaders(hr),
        payload: { fileName: 'a.png', mimeType: 'image/png', sizeBytes: 1024 },
      });
      // 200 when object storage is configured; 422/500 if it is not. Either proves the
      // authorization decision was ALLOW, which is what this asserts — pinning the storage
      // outcome would make an authorization test fail on an unrelated dependency.
      expect(res.statusCode).not.toBe(403);
      expect(res.statusCode).not.toBe(401);
    });
  });
});
