/**
 * End-to-end proof that one action produces exactly ONE audit entry, and that an entry which
 * shares its mutation's transaction commits with it.
 *
 * WHY THIS EXISTS
 * ---------------
 * 40 of 80 audit calls lived in controllers, duplicating a call the service already made for
 * the same event, so a single action wrote two rows. The worst shape was a pair that used the
 * SAME action name: `POST /employees` wrote `employee.created` twice against one
 * `resource_id`, which reads as the employee having been created twice — something the API
 * cannot do. Measured before the fix, not inferred.
 *
 * WHY NOTHING CAUGHT IT
 * ---------------------
 * The unit specs assert `audit.record` WAS CALLED, with a mocked AuditService. Two layers
 * each calling it once satisfies every one of those assertions — a mock cannot count rows in
 * a table. Only a real request that then reads `audit.audit_logs` can see a duplicate, which
 * is why this spec queries the database directly rather than trusting a spy.
 *
 * The ratchet (`test/audit-write.ratchet.spec.ts`) stops a controller audit call being ADDED.
 * This proves the ones removed are actually gone from the output.
 *
 * NO POLLING ANY MORE, AND THAT IS THE POINT. This file used to need a `settledEntriesFor` helper that
 * waited for two identical readings, because `void audit.record(...)` resolved after the response and a
 * reader could legitimately see nothing yet. Every service write now shares its mutation's transaction, so
 * the entry is visible exactly when the change is, and reading straight away is what makes a regression to
 * fire-and-forget observable rather than tolerated. Visibility alone is not proof of atomicity — the
 * rollback case below is — but a poll would have hidden the difference either way.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d` and `pnpm db:seed`.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DRIZZLE, type DrizzleDB } from '@platform';
import { AUDIT_ACTION, AUDIT_RESOURCE, AuditService } from '@modules/audit';
import { FIXTURE, authHeaders, createTestApp, login, type Session } from './support/harness';

let app: NestFastifyApplication;
let admin: Session;
let db: DrizzleDB;
let audit: AuditService;

/** Rows recorded against one resource, by action — the shape a duplicate shows up in. */
async function entriesFor(resourceId: string): Promise<{ action: string; count: number }[]> {
  const rows = await db.execute<{ action: string; count: string }>(sql`
    select action, count(*)::text as count
    from audit.audit_logs
    where resource_id = ${resourceId}
    group by action
    order by action
  `);
  const list = Array.isArray(rows) ? rows : ((rows as { rows: unknown[] }).rows ?? []);
  return (list as { action: string; count: string }[]).map((r) => ({
    action: r.action,
    count: Number(r.count),
  }));
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await login(app, FIXTURE.ADMIN);
  db = app.get<DrizzleDB>(DRIZZLE);
  audit = app.get(AuditService);
});

afterAll(async () => {
  await app?.close();
});

describe('audit trail integrity', () => {
  it('records employee creation exactly once', async () => {
    // The identical-name case: both the controller and the service wrote `employee.created`,
    // so the duplicate was invisible to anyone reading action names.
    const unique = Date.now().toString(36);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/employees',
      headers: authHeaders(admin),
      payload: {
        email: `audit-once-${unique}@opshub.local`,
        displayName: `Audit Once ${unique}`,
        firstName: 'Audit',
        lastName: 'Once',
        employmentType: 'full_time',
        startDate: '2026-01-01',
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const employeeId = (JSON.parse(res.body) as { id: string }).id;

    // NO SETTLE WINDOW. This write is now inside the mutation's transaction, so it is visible exactly
    // when the employee is — polling here would tolerate a regression to fire-and-forget instead of
    // showing it. (Visibility alone does not PROVE atomicity; the rollback case below does that.)
    const entries = await entriesFor(employeeId);

    expect(
      entries,
      'One employee creation must produce one audit row. Two rows with this action means ' +
        'both the controller and the service are recording the same event.',
    ).toEqual([{ action: AUDIT_ACTION.EMPLOYEE_CREATED, count: 1 }]);
  });

  it('records a role creation exactly once, under one action name', async () => {
    // The differing-name case: the service wrote `authz.role.created` and the controller
    // `rbac.role_created`, so the same event appeared under two vocabularies.
    const unique = Date.now().toString(36);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/authz/roles',
      headers: authHeaders(admin),
      payload: {
        key: `audit-once-${unique}`,
        name: `Audit Once ${unique}`,
        description: 'one action, one row',
        permissions: [],
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const roleId = (JSON.parse(res.body) as { id: string }).id;

    const entries = await entriesFor(roleId);

    expect(entries).toEqual([{ action: AUDIT_ACTION.ROLE_CREATED, count: 1 }]);
    // Named explicitly: these are the codes that used to double up, and a regression would
    // reintroduce one of them rather than a second copy of the survivor.
    expect(entries.map((e) => e.action)).not.toContain('rbac.role_created');
  });

  it('records software addition exactly once', async () => {
    const unique = Date.now().toString(36);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/compliance/software',
      headers: authHeaders(admin),
      payload: {
        name: `audit-once-${unique}`,
        vendor: 'Audit',
        licenseType: 'subscription',
        seatsTotal: 1,
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const softwareId = (JSON.parse(res.body) as { id: string }).id;

    const entries = await entriesFor(softwareId);

    expect(entries).toEqual([{ action: AUDIT_ACTION.SOFTWARE_ADDED, count: 1 }]);
    expect(entries.map((e) => e.action)).not.toContain('compliance.software_added');
  });

  it('rolls the audit entry back when the surrounding transaction fails', async () => {
    // THE actual atomicity proof, and it has to force the failure from inside a transaction —
    // an HTTP-level test cannot. Asserting that a transactional entry is merely "present
    // immediately after the response" proves nothing: reverting asset.assign to
    // fire-and-forget still passed that check, because the stray write landed fast enough.
    // Only a rollback distinguishes the two.
    const resourceId = randomUUID();

    await expect(
      db.transaction(async (tx) => {
        await audit.record(
          {
            actorId: FIXTURE.ADMIN.id,
            actorEmail: FIXTURE.ADMIN.email,
            action: AUDIT_ACTION.ASSET_ASSIGNED,
            resourceType: AUDIT_RESOURCE.ASSET,
            resourceId,
          },
          tx,
        );
        // Stand-in for the mutation failing after its audit entry was written.
        throw new Error('mutation failed after the audit write');
      }),
    ).rejects.toThrow('mutation failed after the audit write');

    expect(
      await entriesFor(resourceId),
      'The audit entry survived a rolled-back transaction, so the trail now claims a ' +
        'change happened that did not. That is what passing `tx` exists to prevent.',
    ).toEqual([]);
  });

  it('keeps the audit entry when the surrounding transaction commits', async () => {
    // The other half: `tx` must not make the write conditional on anything but the commit.
    const resourceId = randomUUID();

    await db.transaction(async (tx) => {
      await audit.record(
        {
          actorId: FIXTURE.ADMIN.id,
          actorEmail: FIXTURE.ADMIN.email,
          action: AUDIT_ACTION.ASSET_ASSIGNED,
          resourceType: AUDIT_RESOURCE.ASSET,
          resourceId,
        },
        tx,
      );
    });

    // No settle window: a committed transactional write is visible at once, by definition.
    expect(await entriesFor(resourceId)).toEqual([
      { action: AUDIT_ACTION.ASSET_ASSIGNED, count: 1 },
    ]);
  });

  it('records an asset assignment exactly once through the API', async () => {
    const unique = Date.now().toString(36);
    const assetRes = await app.inject({
      method: 'POST',
      url: '/v1/assets',
      headers: authHeaders(admin),
      payload: {
        assetTag: `AUDIT-${unique}`,
        type: 'laptop',
        model: 'Audit Model',
      },
    });
    expect(assetRes.statusCode, assetRes.body).toBe(201);
    const assetId = (JSON.parse(assetRes.body) as { id: string }).id;

    const assignRes = await app.inject({
      method: 'POST',
      url: `/v1/assets/${assetId}/assign`,
      headers: authHeaders(admin),
      payload: { employeeId: FIXTURE.NO_PERMISSIONS.id },
    });
    // 200: assigning an asset is a transition, not a creation — it always documented 200.
    expect(assignRes.statusCode, assignRes.body).toBe(200);

    // Read immediately, with no polling: a transactional write needs no settle time, and
    // polling here would hide exactly the race this change removes.
    const entries = await entriesFor(assetId);
    const byAction = new Map(entries.map((e) => [e.action, e.count]));

    expect(
      byAction.get(AUDIT_ACTION.ASSET_ASSIGNED),
      'One assignment must produce one audit row.',
    ).toBe(1);
    expect(byAction.get(AUDIT_ACTION.ASSET_CREATED)).toBe(1);
  });
});

describe('the actorEmail filter', () => {
  /**
   * `GET /audit-logs?actorEmail=` — added because the SPA has always shown an "actor email" box while
   * the API only accepted `actorId`, a UUID. The field was collected, committed to state, and never
   * sent: a filter that silently did nothing.
   *
   * Asserted in BOTH directions. A filter that returns rows proves nothing on its own — one that
   * returns everything would also pass — so the second half checks that a different actor's entries
   * are excluded.
   */
  it('matches the actor by a case-insensitive substring, and excludes everybody else', async () => {
    // Two entries by two different actors, written directly so the test does not depend on which
    // mutations happen to be audited.
    const tag = `filter-${Date.now().toString(36)}`;
    await audit.record({
      actorId: FIXTURE.ADMIN.id,
      actorEmail: 'Filter.Probe@OpsHub.local',
      action: AUDIT_ACTION.EMPLOYEE_UPDATED,
      resourceType: AUDIT_RESOURCE.EMPLOYEE,
      resourceId: tag,
      metadata: {},
    });
    await audit.record({
      actorId: FIXTURE.HR.id,
      actorEmail: 'someone.else@opshub.local',
      action: AUDIT_ACTION.EMPLOYEE_UPDATED,
      resourceType: AUDIT_RESOURCE.EMPLOYEE,
      resourceId: tag,
      metadata: {},
    });

    // Lower case in the query against mixed case in the column, and only a fragment of it.
    const res = await app.inject({
      method: 'GET',
      url: `/v1/audit-logs?actorEmail=filter.probe&resourceId=${tag}`,
      headers: authHeaders(admin),
    });
    expect(res.statusCode, res.body).toBe(200);
    const rows = (JSON.parse(res.body) as { data: { actorEmail: string | null }[] }).data;

    expect(rows.length, 'the matching entry must be found by a lower-case fragment').toBe(1);
    expect(rows[0].actorEmail).toBe('Filter.Probe@OpsHub.local');
  });

  it('refuses an empty filter rather than treating it as "everyone"', async () => {
    // `min(1)`: an empty string would otherwise become `ILIKE '%%'`, which matches every row — a
    // filter that appears to be applied and is not.
    const res = await app.inject({
      method: 'GET',
      url: '/v1/audit-logs?actorEmail=',
      headers: authHeaders(admin),
    });
    expect(res.statusCode).toBe(422);
  });
});
