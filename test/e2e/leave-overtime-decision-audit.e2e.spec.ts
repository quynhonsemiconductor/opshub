/**
 * Approving leave and overtime lands a real audit row.
 *
 * `RequestEngine` audits no transition, and both type-defs wrote the domain status and stopped — so
 * approving leave produced no audit entry anywhere. The only `leave.approved` / `overtime.approved`
 * writes lived in a `// Legacy path` branch of `WorkforceService` that `createLeave` and
 * `createOvertime` made unreachable the moment they started setting `requestId` on every row. Two
 * decisions "people are paid on", in that service's own words, went unrecorded.
 *
 * WHY THIS EXISTS ALONGSIDE `decision-audit.type-def.spec.ts`. That spec asserts the calls against a
 * mocked recorder, which proves each hook ASKS for an entry. It cannot prove one arrives: the action
 * and resource strings have to survive `recordChange` and the repository insert, and a bad pair fails
 * at runtime rather than at compile time. So this drives the real routes and reads the real log back.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d` and `pnpm db:seed`.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE, authHeaders, createTestApp, login, type Session } from './support/harness';

let app: NestFastifyApplication;
/** Files the leave and logs the overtime — `@SelfScoped`, so no permission needed. */
let employee: Session;
/** Holds `workforce.approve`, and is NOT the requester: self-approval is refused by design. */
let reviewer: Session;

beforeAll(async () => {
  app = await createTestApp();
  employee = await login(app, FIXTURE.NO_PERMISSIONS);
  reviewer = await login(app, FIXTURE.HR);
});

afterAll(async () => {
  await app?.close();
});

async function post(
  who: Session,
  url: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await app.inject({ method: 'POST', url, headers: authHeaders(who), payload });
  expect(res.statusCode, `${url} → ${res.body}`).toBeLessThan(300);
  return JSON.parse(res.body) as Record<string, unknown>;
}

/** Audit entries for one resource, newest first. `data`, not `items` — that is `buildPageResult`. */
async function auditEntries(
  resourceType: string,
  resourceId: string,
): Promise<{ action: string; actorId: string | null; changes: Record<string, unknown> }[]> {
  const res = await app.inject({
    method: 'GET',
    url: `/v1/audit-logs?resourceType=${resourceType}&resourceId=${resourceId}&limit=50`,
    // The reviewer holds `workforce.approve` but not `audit.read`; the admin reads the log.
    headers: authHeaders(await login(app, FIXTURE.ADMIN)),
  });
  expect(res.statusCode, res.body).toBe(200);
  return (
    JSON.parse(res.body) as {
      data: { action: string; actorId: string | null; changes: Record<string, unknown> }[];
    }
  ).data;
}

describe('leave and overtime decisions reach the audit log', () => {
  it('records an approved leave request against the reviewer who approved it', async () => {
    const filed = await post(employee, '/v1/workforce/leave', {
      leaveType: 'annual',
      startDate: '2026-11-02',
      endDate: '2026-11-03',
      reason: 'e2e: approval must be auditable',
    });
    const leaveId = filed.id as string;

    await post(reviewer, `/v1/workforce/leave/${leaveId}/review`, { approve: true });

    const entries = await auditEntries('leave_request', leaveId);
    const actions = entries.map((e) => e.action);

    // `leave.requested` was already recorded on submit; the DECISION was the missing half.
    expect(actions, JSON.stringify(entries)).toContain('leave.requested');
    expect(actions, JSON.stringify(entries)).toContain('leave.approved');

    const approval = entries.find((e) => e.action === 'leave.approved')!;
    // The reviewer, not the requester. An approval attributed to the person who asked is worse than
    // no record: it reads as a self-approval, which the engine refuses outright.
    expect(approval.actorId).toBe(FIXTURE.HR.id);
    // What the approval cost travels with it — two days and two days minus an afternoon are the same
    // dates and a different decision.
    expect((approval.changes as { after: { workingDays: number } }).after.workingDays).toBe(2);
  });

  it('records a refused overtime entry, with the hours it refused', async () => {
    const logged = await post(employee, '/v1/workforce/overtime', {
      workDate: '2026-11-04',
      hours: 3,
      reason: 'e2e: refusal must be auditable',
    });
    const overtimeId = logged.id as string;

    await post(reviewer, `/v1/workforce/overtime/${overtimeId}/review`, { approve: false });

    const entries = await auditEntries('overtime_entry', overtimeId);
    const refusal = entries.find((e) => e.action === 'overtime.rejected');

    expect(refusal, JSON.stringify(entries)).toBeDefined();
    expect(refusal!.actorId).toBe(FIXTURE.HR.id);
    /*
     * A REFUSAL BY A PERSON HAS AN ACTOR; an expiry does not. Both write `rejected` to the same
     * column, so `actorId` is the only thing in the row that distinguishes "your manager said no"
     * from "nobody looked at it for three days". Asserting it here is what makes the null in the
     * expiry path meaningful.
     */
    expect(refusal!.actorId).not.toBeNull();
  });
});
