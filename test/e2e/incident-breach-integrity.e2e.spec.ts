/**
 * A notified breach cannot stop being a breach, and a bad reference is not a 500.
 *
 * BOTH DEFECTS WERE REPRODUCED AGAINST A RUNNING ENVIRONMENT before they were fixed:
 *
 *   PATCH {"personalDataBreach": true}   -> 200
 *   POST  /regulator-notified            -> 200   regulator_notified_at set
 *   PATCH {"personalDataBreach": false}  -> 200   ← the row now denies the breach it reported
 *   PATCH {"riskId": "<unknown uuid>"}   -> 500   {"code":"INTERNAL_ERROR"}
 *
 * The first is unrecoverable in both directions: `markRegulatorNotified` updates
 * `WHERE personal_data_breach = true AND regulator_notified_at IS NULL`, so it can neither re-stamp
 * nor correct the row, and `/regulator-notified` is the only route there is. Meanwhile the overdue
 * report filters on that same pair, so the incident silently leaves the register a DPO reads while
 * still carrying proof a supervisory authority was told.
 *
 * WHY THIS FILE AND NOT A UNIT SPEC. Three of the assertions here cannot be made against a mock:
 * the CHECK constraint `ck_incident_breach_notification_pair` is enforced by Postgres, the
 * foreign-key resolution reads two other tables, and the HTTP status of a refusal is decided by the
 * exception filter. The unit specs pin the service's decision; this pins that the decision reaches
 * the wire and that the database refuses what the service never sees.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d`, `pnpm db:migrate` (migration 0033).
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '@platform';
import {
  FIXTURE,
  apiRequest,
  createTestApp,
  errorCode,
  login,
  unwrap,
  type Session,
} from './support/harness';

interface IncidentRow {
  id: string;
  personalDataBreach: boolean;
  regulatorNotifiedAt: string | null;
}

let app: NestFastifyApplication;
let db: DrizzleDB;
/** Holds `incident.manage` — the tier that reports and corrects incidents. */
let security: Session;

/** `uq_incident_reference` is global and the database is shared, so references must be unique per run. */
let seq = 0;
const nextRef = () => `E2E-BREACH-${Date.now().toString(36).toUpperCase()}-${++seq}`;

beforeAll(async () => {
  app = await createTestApp();
  db = app.get<DrizzleDB>(DRIZZLE);
  security = await login(app, FIXTURE.SECURITY);
}, 60_000);

afterAll(async () => {
  await app?.close();
});

async function reportBreach(): Promise<IncidentRow> {
  const res = await apiRequest(app, security, 'POST', '/incidents/report', {
    reference: nextRef(),
    title: 'Customer export exposed',
    description: 'A misconfigured bucket exposed a customer export.',
    category: 'data_loss',
    severity: 'critical',
    detectedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    personalDataBreach: true,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return unwrap<IncidentRow>(res.body);
}

describe('a notified breach cannot be un-declared', () => {
  it('refuses to clear the flag once the regulator has been notified', async () => {
    const incident = await reportBreach();

    const notified = await apiRequest(
      app,
      security,
      'POST',
      `/incidents/${incident.id}/regulator-notified`,
      {},
    );
    expect(notified.status, JSON.stringify(notified.body)).toBe(200);
    expect(unwrap<IncidentRow>(notified.body).regulatorNotifiedAt).toBeTruthy();

    const retract = await apiRequest(app, security, 'PATCH', `/incidents/${incident.id}`, {
      personalDataBreach: false,
    });

    // 412 with a code, not the 200 this used to answer.
    expect(retract.status, JSON.stringify(retract.body)).toBe(412);
    expect(errorCode(retract.body)).toBe('INCIDENT_BREACH_NOTIFIED');

    // AND THE ROW DID NOT MOVE. A refusal that still wrote would leave the register exactly as broken.
    const after = await db.execute(
      sql`select personal_data_breach as pdb, regulator_notified_at as notified
            from isms.incidents where id = ${incident.id}`,
    );
    const row = (after.rows ?? after)[0] as { pdb: boolean; notified: Date | null };
    expect(row.pdb).toBe(true);
    expect(row.notified).toBeTruthy();
  });

  it('still allows withdrawing a wrongly-ticked breach that was NEVER notified', async () => {
    /*
     * The other direction, and the one that matters most for not over-fixing: an incident first
     * classified as a breach and then reassessed is the normal correction the register exists for.
     * Only a NOTIFICATION makes the classification irreversible.
     */
    const incident = await reportBreach();

    const withdraw = await apiRequest(app, security, 'PATCH', `/incidents/${incident.id}`, {
      personalDataBreach: false,
    });
    expect(withdraw.status, JSON.stringify(withdraw.body)).toBe(200);
    expect(unwrap<IncidentRow>(withdraw.body).personalDataBreach).toBe(false);
  });

  it('still allows marking an incident a breach after some other notification exists', async () => {
    // Setting the flag TO true must stay possible — the guard is about clearing it, not about the field.
    const incident = await reportBreach();
    const off = await apiRequest(app, security, 'PATCH', `/incidents/${incident.id}`, {
      personalDataBreach: false,
    });
    expect(off.status).toBe(200);

    const on = await apiRequest(app, security, 'PATCH', `/incidents/${incident.id}`, {
      personalDataBreach: true,
    });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(unwrap<IncidentRow>(on.body).personalDataBreach).toBe(true);
  });

  it('is refused by the DATABASE too, for anything that bypasses the service', async () => {
    /*
     * The seed, a migration, a psql session, a future endpoint writing the columns directly. The CHECK
     * is the same rule for all of them, and this is the only kind of test that can reach it.
     *
     * SQLSTATE 23514 is `check_violation`. Asserted by constraint NAME as well, because any other
     * failing CHECK on this table would otherwise satisfy the test.
     */
    const incident = await reportBreach();
    const notified = await apiRequest(
      app,
      security,
      'POST',
      `/incidents/${incident.id}/regulator-notified`,
      {},
    );
    expect(notified.status).toBe(200);

    /*
     * Asserted through `cause`, not the top level: drizzle wraps the driver error, so
     * `toMatchObject({ code: '23514' })` on the thrown object matched nothing and the test failed
     * against a constraint that was in fact working. The pg fields live on the wrapped cause.
     */
    let thrown: unknown;
    try {
      await db.execute(
        sql`update isms.incidents set personal_data_breach = false where id = ${incident.id}`,
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown, 'the database accepted a contradiction the CHECK must refuse').toBeDefined();
    const pg = ((thrown as { cause?: unknown }).cause ?? thrown) as {
      code?: string;
      constraint?: string;
    };
    // 23514 is `check_violation`. The NAME is asserted too, because any other failing CHECK on this
    // table would otherwise satisfy the test.
    expect(pg.code).toBe('23514');
    expect(pg.constraint).toBe('ck_incident_breach_notification_pair');
  });

  it('lets the database store a breach that has NOT been notified yet', async () => {
    /*
     * The floor under the constraint. An EQUIVALENCE (`pdb = (notified is not null)`) would also
     * reject the contradiction above and would additionally forbid this — which is the normal state
     * for the first 72 hours and the entire population of the overdue report. Without this case, that
     * over-strict mutation passes.
     */
    const incident = await reportBreach();
    const rows = await db.execute(
      sql`select personal_data_breach as pdb, regulator_notified_at as notified
            from isms.incidents where id = ${incident.id}`,
    );
    const row = (rows.rows ?? rows)[0] as { pdb: boolean; notified: Date | null };
    expect(row.pdb).toBe(true);
    expect(row.notified).toBeNull();
  });
});

describe('a reference that does not exist is not a server error', () => {
  it('names the unknown riskId instead of answering 500', async () => {
    const incident = await reportBreach();
    const res = await apiRequest(app, security, 'PATCH', `/incidents/${incident.id}`, {
      riskId: '00000000-0000-4000-8000-000000000999',
    });

    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(errorCode(res.body)).toBe('NOT_FOUND');
    // The FIELD, not just the id: a client cannot tell the user what to fix otherwise.
    expect(JSON.stringify(res.body)).toContain('riskId');
  });

  it('names BOTH bad references in one refusal', async () => {
    // One round trip, one message. Reporting only the first would make the second a second surprise.
    const incident = await reportBreach();
    const res = await apiRequest(app, security, 'PATCH', `/incidents/${incident.id}`, {
      riskId: '00000000-0000-4000-8000-000000000998',
      assetId: '00000000-0000-4000-8000-000000000997',
    });

    expect(res.status, JSON.stringify(res.body)).toBe(404);
    const body = JSON.stringify(res.body);
    expect(body).toContain('riskId');
    expect(body).toContain('assetId');
  });

  it('still accepts clearing a reference to null', async () => {
    // `null` is not an unknown reference, it is the absence of one. Resolving it would refuse the
    // only way to unlink a risk.
    const incident = await reportBreach();
    const res = await apiRequest(app, security, 'PATCH', `/incidents/${incident.id}`, {
      riskId: null,
      assetId: null,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});
