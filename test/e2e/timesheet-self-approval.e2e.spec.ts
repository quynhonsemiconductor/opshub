/**
 * Nobody approves their own timesheet.
 *
 * Every other decision in the product is routed through the request engine, which refuses
 * self-approval by `allowSelfApproval: false` on the type definition — leave, overtime, access,
 * onboarding. Timesheets never go near it: `reviewTimesheet` sets the status directly, so it
 * inherited none of that and for a while compared the actor to nothing. A `workforce.approve`
 * holder could file their own hours and approve them, and a timesheet is the record payroll is
 * computed from.
 *
 * THE UI ALREADY WITHHELD THE BUTTON — `timesheetReviewVerdict` in `workforce-policy.ts`, covered by
 * `timesheets-tab.spec.tsx`. That is not the same as the act being refused: those specs render a
 * component, and anybody with a session cookie can POST the route directly. This file is the half
 * that holds, which is why the FE docblock points here rather than claiming to close it.
 *
 * BOTH DIRECTIONS, as the harness convention requires. "HR gets a 403" alone would also be produced
 * by a route broken for everyone, or by a permission check that never passes — so each denial is
 * paired with the same call succeeding for the identity that should be allowed.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d` and `pnpm db:seed`.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE, bearer, createTestApp, login, type Session } from './support/harness';

let app: NestFastifyApplication;
/** Holds `workforce.approve` GLOBALLY — so the only thing that can refuse it here is ownership. */
let hr: Session;
let admin: Session;
/** Holds nothing: self-service is scope, not a permission code. */
let plain: Session;

/**
 * Files a timesheet FOR the given caller and submits it, leaving it in the one status
 * `reviewTimesheet` accepts.
 *
 * `POST /timesheets` is `@SelfScoped` — `employeeId` is `actor.sub` and is not in the body — so who
 * owns the row is decided by whose bearer token creates it. That is the whole mechanism under test.
 *
 * Dates are unique per case and in a year no other spec writes to. There is no unique index on
 * (employeeId, workDate), so a collision would not error; it would quietly make two rows where a
 * case expects one.
 */
async function submittedTimesheet(session: Session, workDate: string): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: '/v1/workforce/timesheets',
    headers: bearer(session),
    payload: { workDate, minutesWorked: 480, note: 'e2e self-approval fixture' },
  });
  expect(created.statusCode, created.body).toBe(201);
  const id = (JSON.parse(created.body) as { id: string }).id;

  const submitted = await app.inject({
    method: 'POST',
    url: `/v1/workforce/timesheets/${id}/submit`,
    headers: bearer(session),
  });
  expect(submitted.statusCode, submitted.body).toBe(201);
  return id;
}

/**
 * The error code out of the response envelope.
 *
 * Errors are `{ error: { code, message } }`, not a bare `{ code }` — reading it flat returns
 * `undefined`, and `expect(undefined).toBe('REQUEST_SOD_VIOLATION')` fails loudly while
 * `expect(undefined).not.toBe(...)` would have PASSED for any error at all, including the wrong one.
 * That asymmetry is why this is a named helper rather than an inline cast at each site.
 */
function errorCode(body: string): string | undefined {
  return (JSON.parse(body) as { error?: { code?: string } }).error?.code;
}

beforeAll(async () => {
  app = await createTestApp();
  hr = await login(app, FIXTURE.HR);
  admin = await login(app, FIXTURE.ADMIN);
  plain = await login(app, FIXTURE.NO_PERMISSIONS);
}, 60_000);

afterAll(async () => {
  await app?.close();
});

describe('timesheet review, separation of duties', () => {
  it('refuses an approver approving their own timesheet, and says why', async () => {
    const id = await submittedTimesheet(hr, '2029-04-02');

    const res = await app.inject({
      method: 'POST',
      url: `/v1/workforce/timesheets/${id}/review`,
      headers: bearer(hr),
      payload: { approve: true },
    });

    expect(res.statusCode, res.body).toBe(403);
    // The engine's code, not a workforce-specific one: a client can tell "ask a colleague" from
    // "ask for access" without knowing which of the two paths answered it.
    expect(errorCode(res.body)).toBe('REQUEST_SOD_VIOLATION');

    /*
     * AND THE ROW DID NOT MOVE. A check placed after the write would produce the same 403 over an
     * already-approved timesheet, so the status is the assertion that matters more than the code.
     *
     * Read back through the LIST route: there is no `GET /timesheets/:id`, so the row is found by id
     * within the owner's own collection rather than fetched directly.
     */
    const after = await app.inject({
      method: 'GET',
      url: `/v1/workforce/timesheets?employeeId=${FIXTURE.HR.id}&limit=100`,
      headers: bearer(hr),
    });
    expect(after.statusCode, after.body).toBe(200);
    const rows = (
      JSON.parse(after.body) as {
        data: { id: string; status: string; approvedBy: string | null }[];
      }
    ).data;
    const row = rows.find((r) => r.id === id);
    expect(row, 'the timesheet under test was not in its own owner list').toBeTruthy();
    expect(row!.status).toBe('submitted');
    expect(row!.approvedBy).toBeNull();
  });

  it('refuses self-REJECTION too, not only self-approval', async () => {
    // `approve: false` is the same decision made the other way. Rejecting your own sheet is the
    // milder act, but it is still the payroll record and still one person on both sides of it —
    // and a check written as `if (approve && ...)` would let this through.
    const id = await submittedTimesheet(hr, '2029-04-03');

    const res = await app.inject({
      method: 'POST',
      url: `/v1/workforce/timesheets/${id}/review`,
      headers: bearer(hr),
      payload: { approve: false },
    });

    expect(res.statusCode, res.body).toBe(403);
    expect(errorCode(res.body)).toBe('REQUEST_SOD_VIOLATION');
  });

  it("lets the same approver decide a COLLEAGUE's timesheet", async () => {
    // The other direction, and the case that proves the 403 above is about identity rather than a
    // route nobody can reach: same permission, same caller, different owner.
    const id = await submittedTimesheet(plain, '2029-04-04');

    const res = await app.inject({
      method: 'POST',
      url: `/v1/workforce/timesheets/${id}/review`,
      headers: bearer(hr),
      payload: { approve: true },
    });

    // 201, not 200: `POST` and no `@HttpCode`, so this is Nest's default and the review route has
    // never said otherwise. Asserted exactly rather than with `res.ok()` — a 204 here would mean the
    // decision was not returned to the caller who made it.
    expect(res.statusCode, res.body).toBe(201);
    const row = JSON.parse(res.body) as { status: string; approvedBy: string };
    expect(row.status).toBe('approved');
    // Who decided is recorded, which is what makes the separation auditable rather than merely
    // enforced at the moment of the click.
    expect(row.approvedBy).toBe(FIXTURE.HR.id);
  });

  it("lets a SECOND approver decide the first approver's timesheet", async () => {
    // The refusal is not "this timesheet cannot be approved" — it is "not by you". So the sheet HR
    // was refused above must still be decidable by somebody else, or the rule would have turned a
    // manager's own hours into a record nobody can ever close.
    const id = await submittedTimesheet(hr, '2029-04-05');

    const res = await app.inject({
      method: 'POST',
      url: `/v1/workforce/timesheets/${id}/review`,
      headers: bearer(admin),
      payload: { approve: true },
    });

    expect(res.statusCode, res.body).toBe(201);
    expect((JSON.parse(res.body) as { status: string }).status).toBe('approved');
  });

  it('still refuses a caller who holds no permission at all, by permission and not by ownership', async () => {
    // Ordering check. The new identity comparison runs BEFORE the status check, so it had to not
    // become a way past the guard: the owner here holds nothing, and `@RequirePermission` must
    // answer first. A 403 either way, so the code is what separates them.
    const id = await submittedTimesheet(plain, '2029-04-06');

    const res = await app.inject({
      method: 'POST',
      url: `/v1/workforce/timesheets/${id}/review`,
      headers: bearer(plain),
      payload: { approve: true },
    });

    expect(res.statusCode, res.body).toBe(403);
    expect(errorCode(res.body)).not.toBe('REQUEST_SOD_VIOLATION');
  });
});
