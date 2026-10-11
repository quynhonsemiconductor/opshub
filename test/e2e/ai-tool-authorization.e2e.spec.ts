/**
 * The AI assistant's tools are the security boundary, and this is the test that says so.
 *
 * `POST /ai/chat` declared `@SelfScoped("the caller's own conversation; no other user's data is
 * reachable")`. The conversation was indeed the caller's; the data was not. `search_employees`
 * selected from `employees` with no predicate, `get_compliance_findings` returned every open finding,
 * and `get_active_access_grants` answered for any employee id — so any authenticated caller could ask
 * the assistant to enumerate staff, standing privileged access, and open security findings.
 *
 * WHY NOTHING CAUGHT IT. `@SelfScoped` satisfies both the boot-time route audit and
 * `route-policy.ratchet.spec.ts`, because each checks that a route DECLARES an authorization mode,
 * not that the declaration is true. The system prompt did say "respect access boundaries" — an
 * instruction to a language model, which is not an access control. Static analysis cannot close this;
 * a test that runs the tools can.
 *
 * WHY THIS DRIVES `executeTool` AND NOT `POST /ai/chat`. The route needs `ANTHROPIC_API_KEY` and a
 * real model round trip to decide which tool to call. A boundary whose only exercise is a paid API
 * call is a boundary nobody runs in CI, so `executeTool` is public and this spec calls it with the
 * real `AuthzService` and the real seeded permissions. The route's own declaration is what points
 * here, and `route-policy.ratchet.spec.ts` asserts this file exists.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d` and `pnpm db:seed`.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AiService } from '../../libs/modules/ai/src/application/ai.service';
import { FIXTURE, authHeaders, createTestApp, login, type Session } from './support/harness';

let app: NestFastifyApplication;
let ai: AiService;

beforeAll(async () => {
  app = await createTestApp();
  // The real provider from the real container, so `AuthzService` resolves the real seeded bundles.
  // A mocked authz here would assert the shape of the code and nothing about the boundary.
  ai = app.get(AiService);
});

/** Submit a real access request as `who`, so the inbox has a row with a known owner. */
async function submitRequestAs(who: Session, justification: string): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/access-requests',
    headers: authHeaders(who),
    payload: {
      accessType: 'app_admin',
      target: 'jira',
      justification,
      durationHours: 8,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
}

afterAll(async () => {
  await app?.close();
});

/** Every tool refusal carries `error`; every success does not. */
function isRefusal(result: unknown): boolean {
  return typeof result === 'object' && result !== null && 'error' in result;
}

describe('AI tool authorization', () => {
  describe('the caller who holds nothing', () => {
    const actor = FIXTURE.NO_PERMISSIONS.id;

    it('is refused the employee directory', async () => {
      const result = await ai.executeTool('search_employees', { query: 'a' }, actor);

      // Named as a permission problem, not as an empty result: "no employees found" would have the
      // assistant tell the user the directory is empty.
      expect(isRefusal(result), JSON.stringify(result)).toBe(true);
      expect((result as { error: string }).error).toContain('employee.read');
      // And it must not have leaked a row on the way to refusing.
      expect(JSON.stringify(result)).not.toContain('@opshub.local');
    });

    it('is refused open compliance findings', async () => {
      const result = await ai.executeTool('get_compliance_findings', {}, actor);
      expect(isRefusal(result), JSON.stringify(result)).toBe(true);
      expect((result as { error: string }).error).toContain('compliance.read');
    });

    it("is refused another employee's standing access", async () => {
      const result = await ai.executeTool(
        'get_active_access_grants',
        { employeeId: FIXTURE.ADMIN.id },
        actor,
      );
      expect(isRefusal(result), JSON.stringify(result)).toBe(true);
      expect((result as { error: string }).error).toContain('access_request.read');
    });

    it('may still read its OWN standing access, with no permission at all', async () => {
      // The mirror of `GET /access-requests/grants/me/active`, which is `@SelfScoped`. If this were
      // refused, the fix for the leak would have removed a capability every employee is meant to
      // have — so this is the assertion that stops the refusal from being over-broad.
      const result = await ai.executeTool('get_active_access_grants', { employeeId: actor }, actor);
      expect(isRefusal(result), JSON.stringify(result)).toBe(false);
      expect(result).toMatchObject({ employeeId: actor });
    });

    it("sees its own pending requests, and not somebody else's", async () => {
      /*
       * TWO REQUESTERS, because one proves nothing.
       *
       * `get_pending_requests` requires no permission BECAUSE `RequestEngine.list` narrows to
       * requester-or-assignee for a caller without `request.read` — that is why it is `null` in
       * `TOOL_PERMISSION`, and this is the test that has to earn it. Asserting only "every row
       * returned belongs to me" passes on an EMPTY list, which is what the broken `'system'` actor
       * produced. So the inbox gets a row that must appear and a row that must not.
       */
      const mine = await login(app, FIXTURE.NO_PERMISSIONS);
      const other = await login(app, FIXTURE.AUDITOR);
      await submitRequestAs(mine, 'e2e: must be visible to its own requester');
      await submitRequestAs(other, 'e2e: must NOT be visible to another employee');

      const own = (await ai.executeTool('get_my_requests', {}, actor)) as { items: unknown[] };
      expect(isRefusal(own), JSON.stringify(own)).toBe(false);

      const pending = (await ai.executeTool('get_pending_requests', { limit: 20 }, actor)) as {
        items: { requesterId: string }[];
      };
      expect(isRefusal(pending), JSON.stringify(pending)).toBe(false);

      const requesters = pending.items.map((r) => r.requesterId);
      // Present: the tool works at all, and the narrowing keeps the caller's own row.
      expect(requesters, "the caller's own pending request is missing").toContain(actor);
      // Absent: the narrowing is real. Without it this is the whole organisation's inbox.
      expect(requesters, "another employee's request is visible").not.toContain(FIXTURE.AUDITOR.id);
    });
  });

  describe('the caller who holds the permissions', () => {
    const actor = FIXTURE.ADMIN.id;

    it('reads the directory and the findings', async () => {
      const employees = (await ai.executeTool('search_employees', {}, actor)) as { count: number };
      expect(isRefusal(employees), JSON.stringify(employees)).toBe(false);
      // The seed creates 11 demo employees, so a working directory read is non-empty. Without this
      // the refusal tests above would pass just as well against a tool that always returns nothing.
      expect(employees.count).toBeGreaterThan(0);

      const findings = await ai.executeTool('get_compliance_findings', {}, actor);
      expect(isRefusal(findings), JSON.stringify(findings)).toBe(false);
    });

    it("reads another employee's standing access", async () => {
      const result = await ai.executeTool(
        'get_active_access_grants',
        { employeeId: FIXTURE.NO_PERMISSIONS.id },
        actor,
      );
      expect(isRefusal(result), JSON.stringify(result)).toBe(false);
      expect(result).toMatchObject({ employeeId: FIXTURE.NO_PERMISSIONS.id });
    });

    it('finds an employee by name rather than by luck', async () => {
      /*
       * The search used to take the newest 10 rows and filter them in JavaScript afterwards, so this
       * assertion is about correctness as much as authorization: `auditor@opshub.local` is findable
       * only if the predicate reaches SQL. With the old code it depended on where that row happened
       * to sort by `created_at`.
       */
      const result = (await ai.executeTool('search_employees', { query: 'auditor' }, actor)) as {
        count: number;
        employees: { email: string }[];
      };

      expect(isRefusal(result), JSON.stringify(result)).toBe(false);
      expect(result.employees.map((e) => e.email)).toContain(FIXTURE.AUDITOR.email);
    });
  });

  it('refuses a tool the model invented, without consulting permissions', async () => {
    // A name not in `TOOL_PERMISSION` is a model error, not an authorization decision. It must not
    // fall through to a default that executes something.
    const result = await ai.executeTool('delete_all_employees', {}, FIXTURE.ADMIN.id);
    expect(isRefusal(result)).toBe(true);
    expect((result as { error: string }).error).toContain('Unknown tool');
  });
});
