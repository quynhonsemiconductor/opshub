/**
 * End-to-end proof of the door-terminal contract (ADR ATTENDANCE-DEVICE §2.4), over the real HTTP
 * surface: a token shown once authenticates a machine principal, the allow-list is computed and
 * ETag-cached with a `no-store`, event batches are per-event validated and idempotent, and the
 * RESPONSES match the contract fixtures in `docs/contracts/door-terminal-v1/` — the same files the
 * firmware repo copies for its host tests, which is what makes this a contract and not a coincidence.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d` and `pnpm db:seed`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '@platform';
import { FIXTURE, authHeaders, createTestApp, login, type Session } from './support/harness';
import { randomUUID } from 'node:crypto';

const ROOT = join(__dirname, '../..');
const FIXTURES = join(ROOT, 'docs/contracts/door-terminal-v1');
interface AllowListFixture {
  cards: { uid: string; valid_from: number | null; valid_until: number | null }[];
}
interface EventsRequestFixture {
  stream: string;
  dropped: number;
  events: {
    seq: number;
    reader: string;
    uid: string;
    result: string;
    device_ts: string;
    time_synced: boolean;
  }[];
}
interface EventsResponseFixture {
  acked_through: number;
  rejected: number[];
}
const read = (name: string): AllowListFixture | EventsRequestFixture | EventsResponseFixture =>
  JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as
    AllowListFixture | EventsRequestFixture | EventsResponseFixture;
const readAllowList = (): AllowListFixture => read('allow-list.json') as AllowListFixture;
const readEventsRequest = (): EventsRequestFixture =>
  read('events-request.json') as EventsRequestFixture;
const readEventsResponse = (): EventsResponseFixture =>
  read('events-response.json') as EventsResponseFixture;

let app: NestFastifyApplication;
let admin: Session;
let db: DrizzleDB;

/** Minted once: token shown once, then used by every terminal-side call. */
let token: string;
let terminalId: string;
const stream = randomUUID();
/** Fresh UIDs per run: the dev DB is shared, and an active-UID duplicate is a 409 by design. */
function randomUid(): string {
  return (
    '04' +
    Math.floor(Math.random() * 0xffffff)
      .toString(16)
      .toUpperCase()
      .padStart(6, '0')
  );
}
let uidA: string;

const bearer = () => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  app = await createTestApp();
  db = app.get<DrizzleDB>(DRIZZLE);
  admin = await login(app, FIXTURE.ADMIN);

  const created = await app.inject({
    method: 'POST',
    url: '/v1/door/terminals',
    headers: authHeaders(admin),
    payload: { name: 'E2E main door', location: 'test rig' },
  });
  expect(created.statusCode, created.body).toBe(201);
  const body = JSON.parse(created.body) as { terminal: { id: string }; token: string };
  terminalId = body.terminal.id;
  token = body.token;
});

afterAll(async () => {
  await app?.close();
});

/** Enrol a card straight through the admin API; returns its id. */
async function enrolCard(
  uid: string,
  window: { validFrom?: string; validUntil?: string | null } = {},
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/door/cards',
    headers: authHeaders(admin),
    payload: { employeeId: admin.userId, uid, ...window },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (JSON.parse(res.body) as { id: string }).id;
}

describe('door terminal contract v1', () => {
  it('refuses a malformed or revoked credential with 401, never a parse error', async () => {
    const garbage = await app.inject({
      method: 'GET',
      url: '/v1/door/terminal/allow-list',
      headers: { authorization: 'Bearer not-a-token' },
    });
    expect(garbage.statusCode).toBe(401);

    const revoked = await app.inject({
      method: 'POST',
      url: `/v1/door/terminals/${terminalId}/revoke`,
      headers: authHeaders(admin),
    });
    expect(revoked.statusCode).toBe(200);

    const after = await app.inject({
      method: 'GET',
      url: '/v1/door/terminal/allow-list',
      headers: bearer(),
    });
    expect(after.statusCode).toBe(401);

    // Revocation is the last word: a NEW token cannot resurrect the terminal (that is what
    // re-provisioning is for) — the admin has to register a replacement.
    const resurrect = await app.inject({
      method: 'POST',
      url: `/v1/door/terminals/${terminalId}/token`,
      headers: authHeaders(admin),
    });
    expect(resurrect.statusCode).toBe(412);

    // Back to a live terminal for the rest of the suite.
    const replacement = await app.inject({
      method: 'POST',
      url: '/v1/door/terminals',
      headers: authHeaders(admin),
      payload: { name: 'E2E main door 2' },
    });
    const body = JSON.parse(replacement.body) as { terminal: { id: string }; token: string };
    terminalId = body.terminal.id;
    token = body.token;
  });

  it('serves the allow-list matching the fixture, with ETag + no-store, and 304s on If-None-Match', async () => {
    uidA = randomUid();
    await enrolCard(uidA); // permanent: valid_from past → sent as null

    const first = await app.inject({
      method: 'GET',
      url: '/v1/door/terminal/allow-list',
      headers: bearer(),
    });
    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toBe('no-store');
    const etag = first.headers.etag;
    expect(etag, 'the response must carry an ETag').toBeTruthy();

    const body = JSON.parse(first.body) as {
      cards: { uid: string; valid_from: number | null; valid_until: number | null }[];
    };
    const ours = body.cards.find((c) => c.uid === uidA);
    // The card is PERMANENT (window defaulted to now, no valid_until): the fixture entry, up to
    // the UID this run enrolled.
    expect(ours).toEqual({ ...readAllowList().cards[0], uid: uidA });
    // Ordered by uid, the whole list's shape is the fixture's shape.
    expect(Object.keys(body)).toEqual(Object.keys(readAllowList()));
    for (const card of body.cards) {
      expect(Object.keys(card).sort()).toEqual(Object.keys(readAllowList().cards[0]).sort());
    }

    const again = await app.inject({
      method: 'GET',
      url: '/v1/door/terminal/allow-list',
      headers: { ...bearer(), 'if-none-match': etag! },
    });
    expect(again.statusCode).toBe(304);

    // Cloudflare weakens ETags when it compresses; the comparison must tolerate that.
    const weak = await app.inject({
      method: 'GET',
      url: '/v1/door/terminal/allow-list',
      headers: { ...bearer(), 'if-none-match': `W/${etag}` },
    });
    expect(weak.statusCode).toBe(304);
  });

  it('includes a future-window card with BOTH windows as epoch seconds, and expires it from the list', async () => {
    const future = new Date(Date.now() + 3600_000);
    const close = new Date(Date.now() + 2 * 3600_000);
    const past = new Date(Date.now() - 1000);
    const uidWindow = randomUid();
    await enrolCard(uidWindow, {
      validFrom: future.toISOString(),
      validUntil: close.toISOString(),
    });
    await enrolCard(randomUid(), {
      validFrom: new Date(Date.now() - 2 * 3600_000).toISOString(),
      validUntil: past.toISOString(),
    }); // already expired: not on the list at all

    const res = await app.inject({
      method: 'GET',
      url: '/v1/door/terminal/allow-list',
      headers: bearer(),
    });
    const body = JSON.parse(res.body) as {
      cards: { uid: string; valid_from: number | null; valid_until: number | null }[];
    };
    const temp = body.cards.find((c) => c.uid === uidWindow);
    // A temporary card fails closed offline: BOTH windows travel (ADR §2.4) — as INTEGER EPOCH
    // SECONDS (bench E2E review item 3): the firmware parser reads uint epoch or null, and an ISO
    // string makes its whole list malformed.
    expect(temp?.valid_from).toBe(Math.floor(future.getTime() / 1000));
    expect(temp?.valid_until).toBe(Math.floor(close.getTime() / 1000));
    expect(body.cards.some((c) => c.valid_until === Math.floor(past.getTime() / 1000))).toBe(false);
  });

  it('accepts a batch matching the fixture, rejects the bad event, and is idempotent on resend', async () => {
    const uidEvents = randomUid();
    await enrolCard(uidEvents);

    const request = readEventsRequest();
    const seq = request.events[0].seq;

    // 1. The EXACT fixture request — a clean batch — answers exactly the fixture response.
    const clean = await app.inject({
      method: 'POST',
      url: '/v1/door/terminal/events',
      headers: { ...bearer(), 'content-type': 'application/json' },
      payload: { ...request, events: [{ ...request.events[0], uid: uidEvents }] },
    });
    expect(clean.statusCode).toBe(200);
    expect(JSON.parse(clean.body)).toEqual(readEventsResponse());

    // 2. A batch with one bad event: acked through EVERYTHING (the terminal deletes through it —
    //    one bad event can never block the queue), bad seqs named.
    const good = {
      stream,
      dropped: 0,
      events: [
        {
          seq: seq + 10,
          reader: 'in' as const,
          uid: uidEvents,
          result: 'allow' as const,
          device_ts: new Date().toISOString(),
          time_synced: true,
        },
        { ...request.events[0], seq: seq + 11, reader: 'sideways' }, // invalid: rejected, not fatal
      ],
    };
    const first = await app.inject({
      method: 'POST',
      url: '/v1/door/terminal/events',
      headers: { ...bearer(), 'content-type': 'application/json' },
      payload: good,
    });
    expect(first.statusCode).toBe(200);
    const body = JSON.parse(first.body) as { acked_through: number; rejected: number[] };
    expect(body).toEqual({ acked_through: seq + 11, rejected: [seq + 11] });

    // 3. The resend after a lost response: same events, nothing changes, same answer.
    const resend = await app.inject({
      method: 'POST',
      url: '/v1/door/terminal/events',
      headers: { ...bearer(), 'content-type': 'application/json' },
      payload: good,
    });
    expect(resend.body).toBe(first.body);
  });

  it('accepts an implausible battery reading with all 9 events, warns, and leaves the badge unchanged', async () => {
    // Bench 2026-10-31: an unwired divider reported 33924 mV. The envelope's old max(20_000)
    // turned every batch into a 422; the terminal retried it forever and lost all attendance.
    // Telemetry is advisory: the events must be acked, the badge must keep its last good value,
    // and the terminal row must surface battery_reading_implausible with the offending value.
    const body = {
      stream,
      dropped: 0,
      battery_mv: 5400,
      low_battery: false,
      events: [
        {
          seq: 1100,
          reader: 'in',
          uid: randomUid(),
          result: 'deny',
          device_ts: new Date().toISOString(),
          time_synced: true,
        },
      ],
    };
    const seeded = await app.inject({
      method: 'POST',
      url: '/v1/door/terminal/events',
      headers: { ...bearer(), 'content-type': 'application/json' },
      payload: body,
    });
    expect(seeded.statusCode, seeded.body).toBe(200);

    // Nine VALID events, all carried by an envelope whose voltage is impossible.
    const events = Array.from({ length: 9 }, (_, i) => ({
      seq: 1200 + i,
      reader: 'in' as const,
      uid: randomUid(),
      result: 'deny' as const,
      device_ts: new Date().toISOString(),
      time_synced: true,
    }));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/door/terminal/events',
      headers: { ...bearer(), 'content-type': 'application/json' },
      payload: { ...body, battery_mv: 33_924, events },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ acked_through: 1208, rejected: [] });

    const listed = await app.inject({
      method: 'GET',
      url: '/v1/door/terminals',
      headers: authHeaders(admin),
    });
    expect(listed.statusCode, listed.body).toBe(200);
    const row = (
      JSON.parse(listed.body) as {
        id: string;
        battery?: { mv: number | null; low: boolean };
        warnings?: { code: string; value: number }[];
      }[]
    ).find((t) => t.id === terminalId);
    // The badge kept the last GOOD reading — the implausible one was never persisted.
    expect(row?.battery?.mv).toBe(5400);
    expect(row?.battery?.low).toBe(false);
    expect(row?.warnings).toEqual([
      expect.objectContaining({ code: 'battery_reading_implausible', value: 33_924 }),
    ]);

    // In range persists exactly as before, and clears the warning.
    const good = await app.inject({
      method: 'POST',
      url: '/v1/door/terminal/events',
      headers: { ...bearer(), 'content-type': 'application/json' },
      payload: { ...body, battery_mv: 5300, events: [] },
    });
    expect(good.statusCode, good.body).toBe(200);
    const after = await app.inject({
      method: 'GET',
      url: '/v1/door/terminals',
      headers: authHeaders(admin),
    });
    const afterRow = (
      JSON.parse(after.body) as {
        id: string;
        battery?: { mv: number | null };
        warnings?: unknown[];
      }[]
    ).find((t) => t.id === terminalId);
    expect(afterRow?.battery?.mv).toBe(5300);
    expect(afterRow?.warnings).toEqual([]);
  });

  it('drops ONLY the UID that was enrolled from the unknown list (bench 2026-10-31)', async () => {
    // The old query computed `bool_or(EXISTS (… WHERE c.uid = ${events.uid} …))` in a single-table
    // select; Drizzle rendered `${events.uid}` unqualified, so inside the subquery it resolved to
    // `c.uid` and the predicate became `c.uid = c.uid`. Once ANY active card existed, every group
    // was "active" and filtered out — Unknown went to 0. A test with ZERO enrolled cards could
    // never have caught this: enrolling exactly one is what makes the broken predicate true.
    const unknowns = [randomUid(), randomUid(), randomUid()];
    const [a, b, c] = unknowns;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/door/terminal/events',
      headers: { ...bearer(), 'content-type': 'application/json' },
      payload: {
        stream,
        dropped: 0,
        events: unknowns.map((uid, i) => ({
          seq: 1300 + i,
          reader: 'in',
          uid,
          result: 'deny',
          device_ts: new Date().toISOString(),
          time_synced: true,
        })),
      },
    });
    expect(res.statusCode, res.body).toBe(200);

    const ours = async () => {
      const listed = await app.inject({
        method: 'GET',
        url: '/v1/door/unknown-cards',
        headers: authHeaders(admin),
      });
      expect(listed.statusCode, listed.body).toBe(200);
      return listed
        .json<{ uid: string }[]>()
        .map((r) => r.uid)
        .filter((uid) => unknowns.includes(uid))
        .sort();
    };

    expect(await ours()).toEqual([a, b, c].sort());

    await enrolCard(a);

    // Before the fix this was [] — every group, not just `a`, fell to the self-comparison.
    expect(await ours()).toEqual([b, c].sort());
  });

  it('resolves card_id by event time, not by "the card active now"', async () => {
    // Card not valid for another hour: a synced swipe NOW credits nobody...
    const future = new Date(Date.now() + 3600_000).toISOString();
    const uidTiming = randomUid();
    await enrolCard(uidTiming, { validFrom: future });
    const early = await app.inject({
      method: 'POST',
      url: '/v1/door/terminal/events',
      headers: { ...bearer(), 'content-type': 'application/json' },
      payload: {
        stream,
        dropped: 0,
        events: [
          {
            seq: 900,
            reader: 'in',
            uid: uidTiming,
            result: 'deny',
            device_ts: new Date().toISOString(),
            time_synced: true,
          },
        ],
      },
    });
    expect(early.statusCode).toBe(200);

    // ...and a swipe INSIDE the window (a future device_ts, synced) credits the card. Buffered
    // events that arrive late must land on the holder's page, not the void.
    const during = await app.inject({
      method: 'POST',
      url: '/v1/door/terminal/events',
      headers: { ...bearer(), 'content-type': 'application/json' },
      payload: {
        stream,
        dropped: 0,
        events: [
          {
            seq: 901,
            reader: 'in',
            uid: uidTiming,
            result: 'allow',
            device_ts: future,
            time_synced: true,
          },
        ],
      },
    });
    expect(during.statusCode).toBe(200);

    // THE CREDIT, seen in the store: seq 901's card_id is the card, seq 900's is null (the
    // window was not open at its device_ts). seq 900 also shows the terminal's unknown-card list
    // would have carried it at enrolment time — the admin-module e2e pins that path.
    const rows = await db.execute<{ seq: number; card_id: string | null }>(
      sql`SELECT seq, card_id FROM "door"."events" WHERE terminal_id = ${terminalId} AND seq IN (900, 901)`,
    );
    const bySeq = new Map(rows.rows.map((r) => [Number(r.seq), r.card_id]));
    expect(bySeq.get(900)).toBeNull();
    expect(bySeq.get(901)).toBeTruthy();
  });

  it('accepts an UNSYNCED uptime-stamped event and credits the card by received_at (bench E2E item 4)', async () => {
    // Card valid now; the terminal had no clock when the swipe happened, so device_ts is an
    // uptime stamp near 1970. Before the fix this FAILED the synced range check yet was acked
    // through — the firmware deleted real attendance.
    const uidUnsynced = randomUid();
    const cardId = await enrolCard(uidUnsynced);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/door/terminal/events',
      headers: { ...bearer(), 'content-type': 'application/json' },
      payload: {
        stream,
        dropped: 0,
        events: [
          {
            seq: 950,
            reader: 'in',
            uid: uidUnsynced,
            result: 'allow',
            device_ts: '1970-01-01T00:00:05Z',
            time_synced: false,
          },
          {
            seq: 951,
            reader: 'out',
            uid: uidUnsynced,
            result: 'allow',
            device_ts: 'not-an-iso-stamp',
            time_synced: false,
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    // The uptime stamp is ACCEPTED (range check is for synced stamps); the shapeless stamp is
    // rejected AND acked — never silently dropped, never left to jam the queue.
    expect(JSON.parse(res.body)).toEqual({ acked_through: 951, rejected: [951] });

    const rows = await db.execute<{
      seq: number;
      card_id: string | null;
      time_synced: boolean;
      device_ts: string;
    }>(
      sql`SELECT seq, card_id, time_synced, device_ts FROM "door"."events" WHERE terminal_id = ${terminalId} AND seq IN (950, 951)`,
    );
    const bySeq = new Map(rows.rows.map((r) => [Number(r.seq), r]));
    const stored = bySeq.get(950);
    expect(stored?.time_synced).toBe(false);
    // The uptime stamp is stored AS SENT (reported as unverified, not rewritten).
    expect(new Date(stored?.device_ts as unknown as string).getTime()).toBe(5000);
    // Credited by RECEIVED time: the card covers now, so the swipe lands on the holder.
    expect(stored?.card_id).toBe(cardId);
    expect(bySeq.get(951)).toBeUndefined();
  });

  it('refuses an oversized terminal payload with 413 before parsing (480/S5)', async () => {
    const big = 'x'.repeat(80 * 1024);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/door/terminal/events',
      headers: { ...bearer(), 'content-type': 'application/json' },
      payload: { stream, dropped: 0, events: [{ seq: 1, pad: big }] },
    });
    expect(res.statusCode).toBe(413);
  });

  it('accumulates a terminal-reported drop count', async () => {
    const dropped = await app.inject({
      method: 'POST',
      url: '/v1/door/terminal/events',
      headers: { ...bearer(), 'content-type': 'application/json' },
      payload: { stream, dropped: 3, events: [] },
    });
    expect(dropped.statusCode).toBe(200);

    const terminals = await app.inject({
      method: 'GET',
      url: '/v1/door/terminals',
      headers: authHeaders(admin),
    });
    const body = JSON.parse(terminals.body) as { id: string; droppedEvents: number }[];
    expect(body.find((t) => t.id === terminalId)?.droppedEvents).toBe(3);
  });

  it('refuses an event envelope that names nothing rejectable', async () => {
    const broken = await app.inject({
      method: 'POST',
      url: '/v1/door/terminal/events',
      headers: { ...bearer(), 'content-type': 'application/json' },
      payload: { stream: 'not-a-uuid', dropped: 0, events: [] },
    });
    // The ENVELOPE is strict about identity fields (stream is a uuid): a batch that cannot be
    // attributed is refused whole — 422, not 200-with-rejects.
    expect(broken.statusCode).toBe(422);
  });
});
