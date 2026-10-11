/**
 * End-to-end proof that approving an access request SUCCEEDS and reports what happened.
 *
 * This exists because the flow was broken and nothing noticed. Approving a request through
 * the engine advances one step of a multi-step workflow, and an intermediate step issues no
 * grant — the request stays `pending` for the next approver. `AccessRequestService.approve`
 * was nevertheless declared `Promise<AccessGrant>` and ended by querying for a grant row
 * that does not exist yet, so it returned `undefined`, the controller read `grant.id`, and
 * the endpoint answered **500 on an approval that had in fact been applied**. A caller saw
 * a server error for a successful action.
 *
 * Why the existing tests missed it, and why this one is shaped the way it is: the unit specs
 * mock the engine, so `engine.approve()` resolving is all they can see, and the reviewer
 * guards (403 on self-approval, 404 on an unknown id) were both correct — the two ENDS of
 * the flow were covered and the middle was not. Only a real request through the real
 * controller, with the real engine deciding there is no grant yet, reaches the defect.
 *
 * TypeScript could not have caught it either: `const [row] = await query` is typed `T`
 * rather than `T | undefined` without `noUncheckedIndexedAccess`.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d` and `pnpm db:seed`.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE, authHeaders, createTestApp, login, type Session } from './support/harness';

let app: NestFastifyApplication;
let requester: Session;
let approver: Session;
/** Holds `access_request.approve` (step 1) and NOT `access_request.security_approve` (step 2). */
let stepOneApprover: Session;

beforeAll(async () => {
  app = await createTestApp();
  // The requester must NOT be the approver: self-approval is refused by design, and a test
  // that used one identity for both would be asserting the refusal instead of the flow.
  requester = await login(app, FIXTURE.NO_PERMISSIONS);
  approver = await login(app, FIXTURE.ADMIN);
  stepOneApprover = await login(app, FIXTURE.MANAGER);
});

afterAll(async () => {
  await app?.close();
});

/** Submit a request as the unprivileged fixture and return its id. */
async function submit(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/access-requests',
    headers: authHeaders(requester),
    payload: {
      accessType: 'app_admin',
      target: 'jira',
      justification: 'e2e: approval must not 500',
      durationHours: 8,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (JSON.parse(res.body) as { id: string }).id;
}

describe('access request approval', () => {
  it('returns the updated request rather than failing when the step issues no grant', async () => {
    const id = await submit();

    const res = await app.inject({
      method: 'POST',
      url: `/v1/access-requests/${id}/approve`,
      headers: authHeaders(approver),
      payload: { note: 'step approved' },
    });

    // The assertion that would have caught the defect: NOT 500.
    expect(res.statusCode, res.body).toBe(201);

    const body = JSON.parse(res.body) as { id: string; status: string };
    expect(body.id).toBe(id);
    // `status` is the contract now — it is how a caller learns whether anything further is
    // required. An intermediate step leaves it `pending`; a final one resolves it. Both are
    // legitimate, so this asserts the field is a real status rather than pinning one value
    // and breaking the day the workflow gains or loses a step.
    expect(['pending', 'approved']).toContain(body.status);
  });

  it('still refuses self-approval and unknown ids', async () => {
    const id = await submit();

    // The requester approving their own request — separation of duties.
    const own = await app.inject({
      method: 'POST',
      url: `/v1/access-requests/${id}/approve`,
      headers: authHeaders(requester),
      payload: {},
    });
    expect(own.statusCode).toBe(403);

    // Well-formed but non-existent: 404, not 500.
    const missing = await app.inject({
      method: 'POST',
      url: '/v1/access-requests/019f0000-0000-7000-8000-000000000000/approve',
      headers: authHeaders(approver),
      payload: {},
    });
    expect(missing.statusCode).toBe(404);
  });

  /*
   * THE TWO-STEP CHAIN, WALKED BY THE TIER IT WAS WRITTEN FOR.
   *
   * `AccessRequestTypeDef.approvalSteps` declares step 1 as `access_request.approve` and step 2 as
   * `access_request.security_approve`, and `db/permissions.catalog.ts` describes the first as the
   * "manager tier". The route nevertheless carried `@RequirePermission('…security_approve')`, so the
   * guard refused every step-1 approver before the engine ever ran — the declared chain had no
   * caller for its first half, silently, with a 403 naming a permission the manager tier is not
   * meant to hold.
   *
   * These two tests are a PAIR and neither is sufficient alone. The first proves the step-1 approver
   * now gets through; the second proves that moving the check into the engine did not simply remove
   * it. `@AuthorizedInService` is only honest if the service really refuses.
   */
  it('lets the step-1 tier approve step 1, which the route-level permission forbade', async () => {
    const id = await submit();

    const res = await app.inject({
      method: 'POST',
      url: `/v1/access-requests/${id}/approve`,
      headers: authHeaders(stepOneApprover),
      payload: { note: 'manager approves step 1' },
    });

    // 201, not the 403 the route-level permission produced.
    expect(res.statusCode, res.body).toBe(201);

    /*
     * STILL `pending`, AND THAT IS CORRECT — two rows carry two statuses.
     *
     * The engine advances `requests.request_items.status` to `in_review`, but this endpoint returns
     * the ACCESS REQUEST, and an access request stays `pending` until a step issues the grant. So
     * the response body cannot show that the step was applied, and neither can `currentStep` — the
     * DTO does not carry it. That is why the next test exists: the only thing that distinguishes
     * "the step was applied" from "the guard let the call through and the engine did nothing" is
     * what the SECOND approval is now asked for.
     */
    expect((JSON.parse(res.body) as { status: string }).status).toBe('pending');
  });

  it('still refuses that same tier at step 2, so the engine check is real', async () => {
    const id = await submit();

    const first = await app.inject({
      method: 'POST',
      url: `/v1/access-requests/${id}/approve`,
      headers: authHeaders(stepOneApprover),
      payload: {},
    });
    expect(first.statusCode, first.body).toBe(201);

    // Same caller, same route, next step — and now the permission the step names is one they do not
    // hold. A 403 here is the whole justification for `@AuthorizedInService`: the check moved, it
    // did not disappear.
    const second = await app.inject({
      method: 'POST',
      url: `/v1/access-requests/${id}/approve`,
      headers: authHeaders(stepOneApprover),
      payload: {},
    });
    expect(second.statusCode, second.body).toBe(403);
    expect(second.body).toContain('access_request.security_approve');
  });

  it('applies the same per-step rule to a refusal', async () => {
    const id = await submit();

    // Rejecting at step 1 is a step-1 decision. The route carried the step-2 code here too, so a
    // manager could not refuse a request they were the named approver of.
    const res = await app.inject({
      method: 'POST',
      url: `/v1/access-requests/${id}/reject`,
      headers: authHeaders(stepOneApprover),
      payload: { note: 'not justified' },
    });

    expect(res.statusCode, res.body).toBe(200);
    expect((JSON.parse(res.body) as { status: string }).status).toBe('rejected');
  });

  it('rejects a malformed id with 400 instead of a database error', async () => {
    // Without ParseUUIDPipe the id reached Postgres and came back as
    // `invalid input syntax for type uuid`, surfaced as a 500 — an unhandled server fault
    // any authenticated caller could trigger with a typo.
    const res = await app.inject({
      method: 'GET',
      url: '/v1/access-requests/not-a-uuid',
      headers: authHeaders(approver),
    });
    expect(res.statusCode).toBe(400);
  });
});
