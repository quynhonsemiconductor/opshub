/**
 * Attendance against a real database — the SQL-side truths the unit table cannot prove:
 * the December month bound, the UTC+7 midnight boundary, unsynced terminal clocks, the
 * month-close lock enforced through the GENERIC /requests routes, the employment-window day
 * bound, and a withdrawal/approval mismatch.
 *
 * Door rows are inserted directly: the terminal ingest path is agent A's lane and already
 * covered by the door suites; what this suite proves is what the DERIVATION makes of the rows.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d` and `pnpm db:seed`.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '@platform';
import { FIXTURE, authHeaders, createTestApp, login, type Session } from './support/harness';

let app: NestFastifyApplication;
let db: DrizzleDB;
let employee: Session;
let admin: Session;
let hr: Session;

beforeAll(async () => {
  app = await createTestApp();
  db = app.get<DrizzleDB>(DRIZZLE);
  employee = await login(app, FIXTURE.NO_PERMISSIONS);
  admin = await login(app, FIXTURE.ADMIN);
  hr = await login(app, FIXTURE.HR);
});

afterAll(async () => {
  await app?.close();
});

/** One allow swipe, inserted raw: a terminal, a card for the employee, and the event itself. */
async function swipe(at: {
  deviceTs: string;
  receivedAt?: string;
  timeSynced: boolean;
  seq: number;
}) {
  const stream = '00000000-0000-4000-8000-0000000000aa';
  await db.execute(sql`
    insert into door.terminals (id, name, token_hash)
    values ('00000000-0000-4000-8000-0000000000b1', 'e2e attendance terminal', ${'x'.repeat(64)})
    on conflict (id) do nothing`);
  await db.execute(sql`
    insert into door.cards (id, employee_id, uid)
    values ('00000000-0000-4000-8000-0000000000b2', ${FIXTURE.NO_PERMISSIONS.id}, 'A2B4C6D8')
    on conflict (id) do nothing`);
  await db.execute(sql`
    insert into door.events (terminal_id, stream, seq, reader, uid, result, card_id, device_ts, time_synced, received_at)
    values (
      '00000000-0000-4000-8000-0000000000b1', ${stream}, ${at.seq}, 'in', 'A2B4C6D8', 'allow',
      '00000000-0000-4000-8000-0000000000b2', ${at.deviceTs}, ${at.timeSynced},
      ${at.receivedAt ?? at.deviceTs}
    )`);
}

/** The employee's derived day rows for a month, as HR sees them. */
async function myDays(month: string) {
  const res = await app.inject({
    method: 'GET',
    url: `/v1/workforce/attendance?month=${month}&employeeId=${FIXTURE.NO_PERMISSIONS.id}`,
    headers: authHeaders(hr),
  });
  expect(res.statusCode, res.body).toBe(200);
  const body = JSON.parse(res.body) as {
    employees: { id: string; days: { date: string; flags: string[] }[] }[];
  };
  const me = body.employees.find((e) => e.id === FIXTURE.NO_PERMISSIONS.id);
  expect(me).toBeDefined();
  return me!.days;
}

describe('the month derivation against real events', () => {
  // The derivation bounds days by EMPLOYMENT (earliest start across the person's contracts), and
  // other suites leave contracts on this employee that start in 2040. Give them one more
  // open-ended contract for the duration: `expired` so it never collides with the one-active-per-
  // person rule, and a null end, which means open-ended whatever the other rows say.
  const derivationContract = '00000000-0000-4000-8000-0000000000c0';

  beforeAll(async () => {
    await db.execute(sql`
      insert into contracts.employment_contracts (id, employee_id, reference, contract_type, start_date, end_date, status, signed_at)
      values (${derivationContract}, ${FIXTURE.NO_PERMISSIONS.id},
              'E2E-ATT-0', 'permanent', '2020-01-01', null, 'expired', now())
      on conflict (id) do nothing`);
  });

  afterAll(async () => {
    await db.execute(
      sql`delete from contracts.employment_contracts where id = ${derivationContract}`,
    );
  });

  it('December events land in December — the bound rolls the year, not the month number', async () => {
    // The seeded holiday calendar may hold New Year's Day, and a holiday day is not listed; this
    // test is about the month bound, so it removes any holiday on the two dates it asserts.
    await db.execute(
      sql`delete from workforce.holidays where date in ('2030-12-31', '2031-01-01')`,
    );
    // 2030-12-31T16:00Z is 23:00 the same day in HCM; 2030-12-31T17:30Z is 2031-01-01 00:30.
    await swipe({ deviceTs: '2030-12-31T16:00:00Z', timeSynced: true, seq: 101 });
    await swipe({ deviceTs: '2030-12-31T17:30:00Z', timeSynced: true, seq: 102 });

    const december = await myDays('2030-12');
    const january = await myDays('2031-01');
    expect(december.some((d) => d.date === '2030-12-31')).toBe(true);
    expect(january.some((d) => d.date === '2031-01-01')).toBe(true);
    // The 17:30Z swipe belongs to January alone, so December 31 holds only the 16:00 one.
    expect(december.find((d) => d.date === '2030-12-31')?.flags).toContain('missing_checkout');
  });

  it('an unsynced terminal is judged by its RECEIVE time and the day says so', async () => {
    // The device clock claims 07:00 (before the day starts — fiction); the server received at 09:05.
    await swipe({
      deviceTs: '2029-06-15T00:00:00Z', // 07:00 HCM, unsynced fiction
      receivedAt: '2029-06-15T02:05:00Z', // 09:05 HCM, the honest time
      timeSynced: false,
      seq: 103,
    });
    const days = await myDays('2029-06');
    const day = days.find((d) => d.date === '2029-06-15');
    expect(day, 'the day exists — the receive time placed it').toBeDefined();
    expect(day!.flags).toContain('unsynced');
  });
});

describe('employment windows bound the days', () => {
  // The auditor: no other suite writes their attendance; their seeded active contract (if any) is
  // parked for the test and restored after, because only one ACTIVE contract may exist per person.
  const person = FIXTURE.AUDITOR.id;
  let parked: string | null = null;

  it('no days before the contract starts — a hire is not an absence', async () => {
    const existing = await db.execute(
      sql`select id from contracts.employment_contracts where employee_id = ${person} and status = 'active'`,
    );
    parked = (existing.rows[0] as { id: string } | undefined)?.id ?? null;
    if (parked) {
      await db.execute(
        sql`update contracts.employment_contracts set status = 'draft' where id = ${parked}`,
      );
    }
    await db.execute(sql`
      insert into contracts.employment_contracts (id, employee_id, reference, contract_type, start_date, end_date, status, signed_at)
      values ('00000000-0000-4000-8000-0000000000c1', ${person},
              'E2E-ATT-1', 'fixed_term', '2026-10-15', '2030-12-31', 'active', now())
      on conflict (id) do nothing`);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/workforce/attendance?month=2026-10&employeeId=${person}`,
      headers: authHeaders(hr),
    });
    expect(res.statusCode, res.body).toBe(200);
    const days = (JSON.parse(res.body) as { employees: { days: { date: string }[] }[] })
      .employees[0]?.days;
    expect(days?.length, 'October days after the 15th exist').toBeGreaterThan(0);
    expect(days.every((d) => d.date >= '2026-10-15')).toBe(true);

    await db.execute(
      sql`delete from contracts.employment_contracts where id = '00000000-0000-4000-8000-0000000000c1'`,
    );
    if (parked) {
      await db.execute(
        sql`update contracts.employment_contracts set status = 'active' where id = ${parked}`,
      );
    }
  });
});

describe('the month close locks decisions through every door', () => {
  it('a closed month refuses a GENERIC /requests approve, and reopen unlocks it', async () => {
    // File leave in a month nothing else uses.
    const filed = await app.inject({
      method: 'POST',
      url: '/v1/workforce/leave',
      headers: authHeaders(employee),
      payload: { leaveType: 'annual', startDate: '2027-03-04', endDate: '2027-03-05' },
    });
    expect(filed.statusCode, filed.body).toBe(201);
    // The DTO does not carry the engine item id; read the backlink from the row.
    const { id: leaveId } = JSON.parse(filed.body) as { id: string };
    const linked = await db.execute(
      sql`select request_id from workforce.leave_requests where id = ${leaveId}`,
    );
    const requestId = (linked.rows[0] as { request_id: string }).request_id;

    const closed = await app.inject({
      method: 'POST',
      url: '/v1/workforce/attendance/months/2027-03/close',
      headers: authHeaders(hr),
      payload: {},
    });
    expect(closed.statusCode, closed.body).toBe(200);

    // THE GENERIC ROUTE: not the leave review route — the engine's own door.
    const approved = await app.inject({
      method: 'POST',
      url: `/v1/requests/${requestId}/approve`,
      headers: authHeaders(hr),
      payload: {},
    });
    expect(approved.statusCode, approved.body).toBe(412);
    expect((JSON.parse(approved.body) as { error?: { code?: string } }).error?.code).toBe(
      'ATTENDANCE_MONTH_CLOSED',
    );

    // The audited admin override unlocks it, and the same approve then lands.
    const reopened = await app.inject({
      method: 'POST',
      url: '/v1/workforce/attendance/months/2027-03/reopen',
      headers: authHeaders(admin),
      payload: { note: 'e2e: correction after review' },
    });
    expect(reopened.statusCode, reopened.body).toBe(200);
    const approvedNow = await app.inject({
      method: 'POST',
      url: `/v1/requests/${requestId}/approve`,
      headers: authHeaders(hr),
      payload: {},
    });
    expect(approvedNow.statusCode, approvedNow.body).toBeLessThan(300);
  });

  it('a closed month refuses a GENERIC /requests cancel too (412), and reopen unlocks it', async () => {
    const filed = await app.inject({
      method: 'POST',
      url: '/v1/workforce/leave',
      headers: authHeaders(employee),
      payload: { leaveType: 'annual', startDate: '2027-05-04', endDate: '2027-05-05' },
    });
    expect(filed.statusCode, filed.body).toBe(201);
    const { id: leaveId } = JSON.parse(filed.body) as { id: string };
    const linked = await db.execute(
      sql`select request_id from workforce.leave_requests where id = ${leaveId}`,
    );
    const requestId = (linked.rows[0] as { request_id: string }).request_id;

    const closed = await app.inject({
      method: 'POST',
      url: '/v1/workforce/attendance/months/2027-05/close',
      headers: authHeaders(hr),
      payload: {},
    });
    expect(closed.statusCode, closed.body).toBe(200);

    const cancelled = await app.inject({
      method: 'POST',
      url: `/v1/requests/${requestId}/cancel`,
      headers: authHeaders(employee),
      payload: {},
    });
    expect(cancelled.statusCode, cancelled.body).toBe(412);
    expect((JSON.parse(cancelled.body) as { error?: { code?: string } }).error?.code).toBe(
      'ATTENDANCE_MONTH_CLOSED',
    );

    const reopened = await app.inject({
      method: 'POST',
      url: '/v1/workforce/attendance/months/2027-05/reopen',
      headers: authHeaders(admin),
      payload: { note: 'e2e: cleanup' },
    });
    expect(reopened.statusCode, reopened.body).toBe(200);
    const cancelledNow = await app.inject({
      method: 'POST',
      url: `/v1/requests/${requestId}/cancel`,
      headers: authHeaders(employee),
      payload: {},
    });
    expect(cancelledNow.statusCode, cancelledNow.body).toBeLessThan(300);
  });

  it('a withdrawn request can no longer be decided — the mismatch guard', async () => {
    const filed = await app.inject({
      method: 'POST',
      url: '/v1/workforce/leave',
      headers: authHeaders(employee),
      payload: { leaveType: 'annual', startDate: '2027-04-06', endDate: '2027-04-07' },
    });
    const { id } = JSON.parse(filed.body) as { id: string };
    const linked = await db.execute(
      sql`select request_id from workforce.leave_requests where id = ${id}`,
    );
    const requestId = (linked.rows[0] as { request_id: string }).request_id;

    const withdrawn = await app.inject({
      method: 'POST',
      url: `/v1/workforce/leave/${id}/cancel`,
      headers: authHeaders(employee),
      payload: {},
    });
    expect(withdrawn.statusCode, withdrawn.body).toBeLessThan(300);

    const approved = await app.inject({
      method: 'POST',
      url: `/v1/requests/${requestId}/approve`,
      headers: authHeaders(hr),
      payload: {},
    });
    // The engine refuses the decided item; nothing resurrects a withdrawal.
    expect(approved.statusCode).toBeGreaterThanOrEqual(400);
  });
});
