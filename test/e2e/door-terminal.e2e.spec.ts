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
import { FIXTURE, authHeaders, createTestApp, login, type Session } from './support/harness';
import { randomUUID } from 'node:crypto';

const ROOT = join(__dirname, '../..');
const FIXTURES = join(ROOT, 'docs/contracts/door-terminal-v1');
interface AllowListFixture {
  cards: { uid: string; valid_from: string | null; valid_until: string | null }[];
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
      cards: { uid: string; valid_from: string | null; valid_until: string | null }[];
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

  it('includes a future-window card with BOTH windows, and expires it from the list', async () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const close = new Date(Date.now() + 2 * 3600_000).toISOString();
    const past = new Date(Date.now() - 1000).toISOString();
    await enrolCard(randomUid(), { validFrom: future, validUntil: close });
    await enrolCard(randomUid(), {
      validFrom: new Date(Date.now() - 2 * 3600_000).toISOString(),
      validUntil: past,
    }); // already expired: not on the list at all

    const res = await app.inject({
      method: 'GET',
      url: '/v1/door/terminal/allow-list',
      headers: bearer(),
    });
    const body = JSON.parse(res.body) as {
      cards: { uid: string; valid_from: string | null; valid_until: string | null }[];
    };
    const temp = body.cards.find((c) => c.valid_from === future);
    // A temporary card fails closed offline: BOTH windows travel (ADR §2.4).
    expect(temp?.valid_from).toBe(future);
    expect(temp?.valid_until).toBe(close);
    expect(body.cards.some((c) => c.valid_until === past)).toBe(false);
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

    const unknown = await app.inject({
      method: 'GET',
      url: '/v1/door/unknown-cards',
      headers: authHeaders(admin),
    });
    const body = JSON.parse(unknown.body) as { uid: string }[];
    // seq 900 resolved to no card (window not open yet) → it IS an unknown-card event.
    expect(body.some((e) => e.uid === uidTiming)).toBe(true);
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
