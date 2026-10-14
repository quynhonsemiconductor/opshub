/**
 * The webhook relay's claim query, and a whole relay pass, against a REAL PostgreSQL.
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
 *   - a full pass (claim, lease, deliver, fail) leaves the row with its attempt spent and the reason recorded.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d`, `pnpm db:migrate`.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, inArray, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebhookRelayService } from '../../libs/modules/webhooks/src/application/webhook-relay.service';
import * as schema from '../../db/schema';
import type { DrizzleDB, DrizzleTx } from '@platform';

const { webhookDeliveries, webhookSubscriptions } = schema;

let pool: Pool;
let db: DrizzleDB;
/** Subscriptions this spec created; their deliveries go with them (ON DELETE CASCADE). Nothing else is touched. */
const created: string[] = [];

/** Exposes the protected claim query: the thing that was broken. */
class ProbeRelay extends WebhookRelayService {
  probeClaim(tx: DrizzleTx, limit = 5) {
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

async function queue(subscriptionId: string): Promise<string> {
  const [row] = await db
    .insert(webhookDeliveries)
    .values({ subscriptionId, eventType: 'request.approved', payload: { n: 1 } })
    .returning({ id: webhookDeliveries.id });
  return row.id;
}

beforeAll(() => {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is required');
  pool = new Pool({ connectionString: url, max: 4 });
  db = drizzle(pool, { schema });
});
afterAll(async () => {
  await pool?.end();
});
afterEach(async () => {
  if (created.length) {
    await db.delete(webhookSubscriptions).where(inArray(webhookSubscriptions.id, created));
    created.length = 0;
  }
});

describe('WebhookRelayService against PostgreSQL', () => {
  it('claims a due delivery with its subscription url and secret', async () => {
    const subscriptionId = await subscribe('https://hooks.example.test/in');
    const deliveryId = await queue(subscriptionId);

    const rows = await db.transaction((tx) => new ProbeRelay(db).probeClaim(tx));

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
    const relay = new ProbeRelay(db);

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
      secondClaim = (await db.transaction((other) => relay.probeClaim(other, 100))).filter(
        (r) => r.id === deliveryId,
      ).length;
    });

    expect(subscriptionLockable, 'the join locked the subscription row').toBe(true);
    expect(deliveryLockError, 'the delivery row was not locked by the claim').toMatch(
      /could not obtain lock|55P03/,
    );
    expect(secondClaim).toBe(0);
  });

  it('a whole pass claims, leases, fails and records the reason (no network: the target is refused)', async () => {
    // The relay refuses a non-https or private target before any request is made, so the row takes the ordinary
    // failure path deterministically and the spec needs no network.
    const subscriptionId = await subscribe('http://127.0.0.1:9/hook');
    const deliveryId = await queue(subscriptionId);

    await new WebhookRelayService(db).relay();

    const [row] = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, deliveryId));
    expect(row?.attempts).toBe(1);
    expect(row?.status).toBe('pending');
    expect(row?.lastError ?? '').toContain('Refusing to deliver');
    expect(row?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });
});
