/**
 * The reporting window and the database clock.
 *
 * Rows are stamped by the DATABASE's now(). A report with no explicit bounds must end at that same clock, not at the
 * application host's. This injects the skew: the host clock runs one hour BEHIND the database for the request, which
 * is the direction that drops the newest rows out of their own window. It fails on a build whose default `to` comes
 * from the host.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FIXTURE, apiRequest, createTestApp, login, unwrap, type Session } from './support/harness';

let app: NestFastifyApplication;
let reader: Session;
let employee: Session;

beforeAll(async () => {
  app = await createTestApp();
  reader = await login(app, FIXTURE.ADMIN);
  employee = await login(app, FIXTURE.NO_PERMISSIONS);
});

afterAll(async () => {
  vi.useRealTimers();
  await app?.close();
});

interface OvertimeRow {
  count: number;
}

describe('the overtime summary and the database clock', () => {
  it('counts a row the database stamped a moment ago, when the host clock runs an hour behind', async () => {
    const logged = await apiRequest(app, employee, 'POST', '/workforce/overtime', {
      workDate: '2027-03-15',
      hours: 4,
      reason: 'e2e: stamped by the database, read back under a host clock behind it',
    });
    expect(logged.status, JSON.stringify(logged.body)).toBe(201);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() - 60 * 60_000);
    try {
      const res = await apiRequest(app, reader, 'GET', '/reports/workforce/overtime');
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const rows = unwrap<{ rows: OvertimeRow[] }>(res.body).rows;
      expect(
        rows.reduce((n, r) => n + r.count, 0),
        'the newest row sorted past the host-clock `to` and was dropped',
      ).toBeGreaterThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
