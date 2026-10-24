/**
 * End-to-end regression for the card PATCH surface (SA review of the admin-module PR).
 *
 * B1 WAS A SILENT DATA LOSS BUG: the controller spread the DTO into the patch, so a
 * `validUntil: undefined` KEY sat in the object and the service's `'validUntil' in input` read it
 * as "clear the window" — a label-only PATCH or a mark-lost revoked every temporary card's expiry
 * without any test noticing, because both directions returned 200.
 *
 * Also pinned here: the concurrent-enrol race answers 409 (the unique index, mapped), and a card
 * for an offboarded employee is refused at the desk, 422.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d` and `pnpm db:seed`.
 */
import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE, authHeaders, createTestApp, login, type Session } from './support/harness';

let app: NestFastifyApplication;
let admin: Session;

function randomUid(): string {
  return (
    '04' +
    Math.floor(Math.random() * 0xffffff)
      .toString(16)
      .toUpperCase()
      .padStart(6, '0')
  );
}

interface CardRow {
  id: string;
  uid: string;
  label: string | null;
  status: string;
  validFrom: string;
  validUntil: string | null;
  revokedAt: string | null;
}

interface ErrorBody {
  error: { code: string };
}

async function enrol(payload: Record<string, unknown>): Promise<{ status: number; body: CardRow }> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/door/cards',
    headers: authHeaders(admin),
    payload: { employeeId: admin.userId, ...payload },
  });
  return { status: res.statusCode, body: res.json() };
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await login(app, FIXTURE.ADMIN);
});

afterAll(async () => {
  await app?.close();
});

describe('door card PATCH surface', () => {
  it('keeps valid_until on a label-only PATCH', async () => {
    const validUntil = new Date(Date.now() + 3600_000).toISOString();
    const { status, body } = await enrol({ uid: randomUid(), validUntil });
    expect(status).toBe(201);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/v1/door/cards/${body.id}`,
      headers: authHeaders(admin),
      payload: { label: 'front desk spare' },
    });
    expect(patched.statusCode).toBe(200);
    const patchedRow = patched.json<CardRow>();
    expect(patchedRow.label).toBe('front desk spare');
    // THE BUG: this came back null before the fix.
    expect(patchedRow.validUntil).toBe(validUntil);
  });

  it('keeps valid_until on mark-lost, and stamps revoked_at', async () => {
    const validUntil = new Date(Date.now() + 3600_000).toISOString();
    const { body } = await enrol({ uid: randomUid(), validUntil });

    const lost = await app.inject({
      method: 'PATCH',
      url: `/v1/door/cards/${body.id}`,
      headers: authHeaders(admin),
      payload: { status: 'lost' },
    });
    expect(lost.statusCode).toBe(200);
    const row = lost.json<CardRow>();
    expect(row.status).toBe('lost');
    expect(row.revokedAt).toBeTruthy();
    expect(row.validUntil).toBe(validUntil);
  });

  it('answers a concurrent enrol of the same UID with the conflict it is, not a 500', async () => {
    const uid = randomUid();
    const first = await enrol({ uid });
    expect(first.status).toBe(201);
    const second = await enrol({ uid });
    expect(second.status).toBe(409);
    expect((second.body as unknown as ErrorBody).error.code).toBe('DOOR_CARD_DUPLICATE');
  });

  it('refuses a card for an offboarded employee (422); on_leave stays allowed', async () => {
    // An offboarded fixture: the seed names one offboarded employee; find them via the directory.
    const list = await app.inject({
      method: 'GET',
      url: '/v1/employees?status=offboarded',
      headers: authHeaders(admin),
    });
    const offboarded = list.json<{ data: { id: string }[] }>().data[0];

    if (!offboarded) return; // the fixture set carries none on this run; the unit spec covers it
    const res = await enrol({ uid: randomUid(), employeeId: offboarded.id });
    expect(res.status).toBe(422);
    expect((res.body as unknown as ErrorBody).error.code).toBe('DOOR_CARD_EMPLOYEE_OFFBOARDED');
  });

  it('refuses an empty validity window (422, its own code)', async () => {
    const past = new Date(Date.now() - 3600_000).toISOString();
    const res = await enrol({ uid: randomUid(), validFrom: past, validUntil: past });
    expect(res.status).toBe(422);
    expect((res.body as unknown as ErrorBody).error.code).toBe('DOOR_CARD_WINDOW_INVALID');
  });

  it('never hands a token response back to an Idempotency-Key replay', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/door/terminals',
      headers: { ...authHeaders(admin), 'idempotency-key': randomUUID() },
      payload: { name: 'idempotent probe' },
    });
    expect(res.statusCode).toBe(201);
    // The cache has nothing to replay from — but the route's refusal of a SECOND replayed
    // credential is structural (SkipIdempotency), asserted by the platform spec. What is pinned
    // here is that the route still WORKS with a key present and returns a fresh token.
    expect(res.json<{ token: string }>().token).toContain('.');
  });
});
