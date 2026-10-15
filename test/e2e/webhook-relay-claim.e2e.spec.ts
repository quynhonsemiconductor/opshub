/**
 * The webhook relay's claim query, expiry and a whole relay pass, against a REAL PostgreSQL.
 *
 * `WebhookRelayService.selectDue` used `.for('update', { skipLocked: true, of: webhookDeliveries })` on a table in
 * `pgSchema('messaging')`. Drizzle renders that `FOR UPDATE OF "messaging"."webhook_deliveries"`, which Postgres
 * rejects (`FOR UPDATE must specify unqualified relation names`, SQLSTATE 0A000), so every pass failed and no outgoing
 * webhook was ever delivered. NO test ran the claim: the unit specs replace the SQL, and the other e2e specs queue
 * deliveries without relaying them. A mocked transaction cannot see this class of bug; only the database can.
 *
 * Asserted here:
 *   - the claim runs, and returns the due delivery with its subscription's url and secret;
 *   - it locks the DELIVERY row and NOT the subscription row (the join must not lock subscriptions);
 *   - a delivery another relay holds is skipped, not waited for;
 *   - a full pass (claim, lease, deliver, fail) leaves the row with its attempt spent and the reason recorded;
 *   - EXPIRY: a delivery pending longer than WEBHOOK_DELIVERY_MAX_AGE_HOURS is marked failed and NEVER fetched, a fresh
 *     one is delivered, and neither a live lease nor a row another transaction holds is touched.
 *
 * SHARED DATABASE. Other specs leave rows in these tables (the request flows fan deliveries out by the hundred), and
 * a claim is oldest-first with a limit while a pass claims EVERY due row. So every test first PARKS the other pending
 * rows (next_attempt_at in the future, restored afterwards): the claim probes then cannot lose our row to a leftover
 * one however many there are, and a whole pass touches nothing but this spec's rows. `fetch` is stubbed wherever a
 * pass could reach it, so no test makes a network request.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d`, `pnpm db:migrate`.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebhookRelayService } from '../../libs/modules/webhooks/src/application/webhook-relay.service';
import * as schema from '../../db/schema';
import type { AppConfigService, DrizzleDB, DrizzleTx } from '@platform';

const { webhookDeliveries, webhookSubscriptions } = schema;

const MAX_AGE_HOURS = 24;
const HOUR_MS = 3_600_000;
/** A public IP literal: the relay's SSRF check accepts it without a DNS lookup, and `fetch` is stubbed anyway. */
const PUBLIC_TARGET = 'https://93.184.216.34/hook';

let pool: Pool;
let db: DrizzleDB;
/** Subscriptions this spec created; their deliveries go with them (ON DELETE CASCADE). */
const created: string[] = [];
/** Pending rows parked for the duration of a test, with the `next_attempt_at` to give back. */
let parked: Array<{ id: string; nextAttemptAt: Date }> = [];

const config = { get: () => MAX_AGE_HOURS } as unknown as AppConfigService;
const makeRelay = () => new ProbeRelay(db, config);
/** A relay that expires only 2 rows per claim, so a backlog of 5 is bigger than one claim's cap. */
class CappedRelay extends WebhookRelayService {
  protected override readonly expirePerClaim = 2;
}

/** Exposes the protected claim query: the thing that was broken. */
class ProbeRelay extends WebhookRelayService {
  probeClaim(tx: DrizzleTx, limit = 100) {
    return this.selectDue(tx, limit, new Date());
  }
}

async function subscribe(url = 'http://127.0.0.1:9/hook'): Promise<string> {
  const [row] = await db
    .insert(webhookSubscriptions)
    .values({ url, secret: 'e2e-secret-value-long-enough', events: ['request.approved'] })
    .returning({ id: webhookSubscriptions.id });
  created.push(row.id);
  return row.id;
}

/**
 * `nextAttemptAt` is set EXPLICITLY, a minute in the past. The column defaults to the DATABASE's `now()` and the claim
 * compares it with the HOST's clock; the Postgres container's runs a couple of milliseconds ahead (measured: median
 * +1.7 ms, never behind), so a row claimed right after it is inserted is "in the future" and not due. That made these
 * tests fail about one full run in three. Production never claims a row milliseconds after inserting it.
 */
async function queue(
  subscriptionId: string,
  extra: Partial<typeof webhookDeliveries.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(webhookDeliveries)
    .values({
      subscriptionId,
      eventType: 'request.approved',
      payload: { n: 1 },
      nextAttemptAt: new Date(Date.now() - 60_000),
      ...extra,
    })
    .returning({ id: webhookDeliveries.id });
  return row.id;
}

const load = async (id: string) =>
  (await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id)))[0];

/** Push every OTHER pending row an hour out, so a whole pass sees only this spec's rows. Undone in afterEach. */
async function parkOthers(mine: string[]): Promise<void> {
  const others = await db
    .select({ id: webhookDeliveries.id, nextAttemptAt: webhookDeliveries.nextAttemptAt })
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.status, 'pending')));
  parked = others.filter((r) => !mine.includes(r.id));
  if (parked.length) {
    await db
      .update(webhookDeliveries)
      .set({ nextAttemptAt: new Date(Date.now() + HOUR_MS) })
      .where(
        inArray(
          webhookDeliveries.id,
          parked.map((r) => r.id),
        ),
      );
  }
}

beforeAll(() => {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is required');
  pool = new Pool({ connectionString: url, max: 4 });
  db = drizzle(pool, { schema });
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const row of parked) {
    // Only if still pending and still parked: a row a test legitimately changed is left as it is.
    await db
      .update(webhookDeliveries)
      .set({ nextAttemptAt: row.nextAttemptAt })
      .where(and(eq(webhookDeliveries.id, row.id), eq(webhookDeliveries.status, 'pending')));
  }
  parked = [];
  if (created.length) {
    await db.delete(webhookSubscriptions).where(inArray(webhookSubscriptions.id, created));
    created.length = 0;
  }
});
afterAll(async () => {
  await pool?.end();
});

describe('WebhookRelayService claim, against PostgreSQL', () => {
  it('claims a due delivery with its subscription url and secret', async () => {
    const subscriptionId = await subscribe('https://hooks.example.test/in');
    const deliveryId = await queue(subscriptionId);
    await parkOthers([deliveryId]);

    const rows = await db.transaction((tx) => makeRelay().probeClaim(tx));

    const mine = rows.filter((r) => r.id === deliveryId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      id: deliveryId,
      subscriptionId,
      eventType: 'request.approved',
      url: 'https://hooks.example.test/in',
      secret: 'e2e-secret-value-long-enough',
    });
  });

  it('locks the delivery row and NOT the subscription row, and skips a row another relay holds', async () => {
    const subscriptionId = await subscribe();
    const deliveryId = await queue(subscriptionId);
    await parkOthers([deliveryId]);
    const relay = makeRelay();

    let subscriptionLockable = false;
    let deliveryLockError = '';
    let secondClaim = -1;

    await db.transaction(async (tx) => {
      const claimed = await relay.probeClaim(tx);
      expect(claimed.map((r) => r.id)).toContain(deliveryId);

      // From ANOTHER connection, while the claim's transaction is open.
      await db.transaction(async (other) => {
        // The subscription: an API call editing it must not wait behind a relay pass.
        await other.execute(
          sql`SELECT 1 FROM messaging.webhook_subscriptions WHERE id = ${subscriptionId} FOR UPDATE NOWAIT`,
        );
        subscriptionLockable = true;
      });
      try {
        await db.transaction(async (other) => {
          await other.execute(
            sql`SELECT 1 FROM messaging.webhook_deliveries WHERE id = ${deliveryId} FOR UPDATE NOWAIT`,
          );
        });
      } catch (err) {
        deliveryLockError = JSON.stringify(err, Object.getOwnPropertyNames(err));
      }
      // A second relay skips the held row instead of waiting for it.
      secondClaim = (await db.transaction((other) => relay.probeClaim(other))).filter(
        (r) => r.id === deliveryId,
      ).length;
    });

    expect(subscriptionLockable, 'the join locked the subscription row').toBe(true);
    expect(deliveryLockError, 'the delivery row was not locked by the claim').toMatch(
      /could not obtain lock|55P03/,
    );
    expect(secondClaim).toBe(0);
  });
});

describe('WebhookRelayService whole pass, against PostgreSQL', () => {
  it('claims, leases, fails and records the reason (no network: the target is refused)', async () => {
    // The relay refuses a non-https or private target before any request is made, so the row takes the ordinary
    // failure path deterministically.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const subscriptionId = await subscribe('http://127.0.0.1:9/hook');
    const deliveryId = await queue(subscriptionId);
    await parkOthers([deliveryId]);

    await makeRelay().relay();

    const row = await load(deliveryId);
    expect(row.attempts).toBe(1);
    expect(row.status).toBe('pending');
    expect(row.lastError ?? '').toContain('Refusing to deliver');
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('WebhookRelayService expiry, against PostgreSQL', () => {
  const hoursAgo = (h: number) => new Date(Date.now() - h * HOUR_MS);

  it('expires a delivery pending longer than the maximum age WITHOUT fetching it, and delivers a fresh one', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));
    const subscriptionId = await subscribe(PUBLIC_TARGET);
    const oldId = await queue(subscriptionId, { createdAt: hoursAgo(MAX_AGE_HOURS + 1) });
    const freshId = await queue(subscriptionId);
    await parkOthers([oldId, freshId]);

    await makeRelay().relay();

    const old = await load(oldId);
    expect(old.status).toBe('failed');
    expect(old.lastError).toBe(`expired: pending longer than ${MAX_AGE_HOURS} h`);
    expect(old.attempts, 'an expired row spends no attempt').toBe(0);
    expect(old.leaseToken).toBeNull();
    expect(old.deliveredAt).toBeNull();

    const fresh = await load(freshId);
    expect(fresh.status).toBe('delivered');

    const sentIds = fetchSpy.mock.calls.map(
      ([, init]) => (init?.headers as Record<string, string>)['X-OpsHub-Delivery'],
    );
    expect(sentIds).toContain(freshId);
    expect(sentIds, 'the expired delivery was sent').not.toContain(oldId);
  });

  it('keeps the row (no delete) and leaves a delivery inside the maximum age alone', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
    const subscriptionId = await subscribe(PUBLIC_TARGET);
    const justInside = await queue(subscriptionId, { createdAt: hoursAgo(MAX_AGE_HOURS - 1) });
    await parkOthers([justInside]);

    await makeRelay().relay();

    expect((await load(justInside)).status).toBe('delivered');
  });

  it('does not expire a row whose lease is live: a relay is delivering it', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const subscriptionId = await subscribe(PUBLIC_TARGET);
    const leased = await queue(subscriptionId, {
      createdAt: hoursAgo(MAX_AGE_HOURS + 5),
      leaseToken: '11111111-1111-4111-8111-111111111111',
      lockedUntil: new Date(Date.now() + 5 * 60_000),
    });
    await parkOthers([leased]);

    await makeRelay().relay();

    const row = await load(leased);
    expect(row.status).toBe('pending');
    expect(row.leaseToken).toBe('11111111-1111-4111-8111-111111111111');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skips a row another transaction holds, instead of waiting for it, and expires it once it is released', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
    const subscriptionId = await subscribe(PUBLIC_TARGET);
    const held = await queue(subscriptionId, { createdAt: hoursAgo(MAX_AGE_HOURS + 2) });
    await parkOthers([held]);

    let statusWhileHeld = '';
    await db.transaction(async (holder) => {
      await holder.execute(
        sql`SELECT 1 FROM messaging.webhook_deliveries WHERE id = ${held} FOR UPDATE`,
      );
      // A whole pass on another connection: it must neither wait for the held row nor touch it.
      await makeRelay().relay();
      statusWhileHeld = (await load(held)).status;
    });
    expect(statusWhileHeld).toBe('pending');

    await makeRelay().relay();
    expect((await load(held)).status).toBe('failed');
  });

  it('NEVER sends an over-age row, even when the backlog is bigger than one claim expires', async () => {
    // beforeSelect expires at most `expirePerClaim` rows. The claim's own age predicate is what keeps the REST of
    // the over-age rows from being claimed and sent in the same pass.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));
    const subscriptionId = await subscribe(PUBLIC_TARGET);
    const overAge: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      overAge.push(await queue(subscriptionId, { createdAt: hoursAgo(MAX_AGE_HOURS + 1 + i) }));
    }
    const freshId = await queue(subscriptionId);
    await parkOthers([...overAge, freshId]);
    const relay = new CappedRelay(db, config);

    await relay.relay();

    const sentAfterFirstPass = fetchSpy.mock.calls.map(
      ([, init]) => (init?.headers as Record<string, string>)['X-OpsHub-Delivery'],
    );
    expect(sentAfterFirstPass).toEqual([freshId]);
    for (const id of overAge) {
      expect((await load(id)).status, 'an over-age row was delivered').not.toBe('delivered');
    }

    // The cap only slows the draining: a few more passes expire all five, and still nothing old is sent.
    for (let pass = 0; pass < 6; pass += 1) await relay.relay();
    for (const id of overAge) {
      const row = await load(id);
      expect(row.status).toBe('failed');
      expect(row.lastError).toBe(`expired: pending longer than ${MAX_AGE_HOURS} h`);
    }
    const sentIds = fetchSpy.mock.calls.map(
      ([, init]) => (init?.headers as Record<string, string>)['X-OpsHub-Delivery'],
    );
    expect(sentIds.filter((id) => overAge.includes(id))).toEqual([]);
  });

  it('does not touch rows that are not pending', async () => {
    const subscriptionId = await subscribe(PUBLIC_TARGET);
    const delivered = await queue(subscriptionId, {
      createdAt: hoursAgo(MAX_AGE_HOURS + 10),
      status: 'delivered',
      deliveredAt: hoursAgo(MAX_AGE_HOURS + 9),
    });
    await parkOthers([delivered]);

    await makeRelay().relay();

    const row = await load(delivered);
    expect(row.status).toBe('delivered');
    expect(row.lastError).toBeNull();
  });
});
