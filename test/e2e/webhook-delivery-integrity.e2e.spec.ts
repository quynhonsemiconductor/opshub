/**
 * A webhook delivery cannot outlive the subscription it was queued for.
 *
 * `messaging.webhook_deliveries.subscription_id` was `NOT NULL` with no foreign key — not in the
 * drizzle schema and not in any migration — while `WebhooksService.delete` hard-deletes the parent
 * row. Deleting a subscription therefore left its deliveries behind, pointing at an id that no longer
 * resolved.
 *
 * NOTHING REPORTED THEM, which is what made this worth a migration rather than a note.
 * `WebhookRelayService` claims work with an INNER JOIN onto `webhook_subscriptions`, so an orphan
 * simply stops being selected: `pending`, `attempts = 0`, forever. Never retried, never dead-lettered,
 * and invisible to the `outboxDeadLetter` alarm, which watches the dead-letter field rather than the
 * pending queue. The table grows and the operator sees nothing.
 *
 * WHY THIS SPEC EXISTS RATHER THAN TRUSTING THE MIGRATION. A constraint is only as good as its
 * presence in the database the app actually talks to, and a schema declaration cannot prove one: a
 * `.references()` in drizzle does nothing at runtime here, because migrations are hand-written. So
 * this drives the real API and then asks the real database what happened.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d` and `pnpm db:seed`.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '@platform';
import { webhookDeliveries } from '../../db/schema';
import { FIXTURE, authHeaders, createTestApp, login, type Session } from './support/harness';

let app: NestFastifyApplication;
let db: DrizzleDB;
/** Holds `*`, so it satisfies `webhooks.manage` on every route in the module. */
let admin: Session;

beforeAll(async () => {
  app = await createTestApp();
  db = app.get<DrizzleDB>(DRIZZLE);
  admin = await login(app, FIXTURE.ADMIN);
});

afterAll(async () => {
  await app?.close();
});

/** Create a subscription through the real route and return its id. */
async function createSubscription(description: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/webhooks/subscriptions',
    headers: authHeaders(admin),
    payload: {
      url: 'https://example.test/hook',
      secret: 'e2e-secret-value-long-enough',
      events: ['request.approved'],
      description,
    },
  });
  expect(res.statusCode, res.body).toBeLessThan(300);
  return (JSON.parse(res.body) as { id: string }).id;
}

/**
 * Queue a delivery directly.
 *
 * There is no route that creates one — deliveries are fanned out by the relay when a domain event
 * fires, and driving a real fan-out here would test the fan-out rather than the constraint.
 */
async function queueDelivery(subscriptionId: string): Promise<void> {
  await db
    .insert(webhookDeliveries)
    .values({ subscriptionId, eventType: 'request.approved', payload: {} });
}

async function deliveryCount(subscriptionId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.subscriptionId, subscriptionId));
  return row?.n ?? 0;
}

describe('webhook delivery integrity', () => {
  /** Try to register a subscription pointing at `url`, and return the status. */
  async function attempt(url: string): Promise<{ status: number; body: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/subscriptions',
      headers: authHeaders(admin),
      payload: {
        url,
        secret: 'e2e-secret-value-long-enough',
        events: ['request.approved'],
        description: 'ssrf probe',
      },
    });
    return { status: res.statusCode, body: res.body };
  }

  it.each([
    ['https://169.254.169.254/latest/meta-data/', 'the cloud metadata endpoint'],
    ['https://169.254.170.2/v2/credentials', 'the ECS task credential endpoint'],
    ['https://127.0.0.1:3001/v1/employees', 'the API itself'],
    ['https://10.0.4.17:5432/', 'RDS'],
    ['https://localhost/hook', 'a local hostname'],
    ['https://[::1]/hook', 'IPv6 loopback'],
    ['http://hooks.example.com/hook', 'plaintext http'],
  ])('refuses a subscription aimed at %s (%s)', async (url) => {
    /*
     * THROUGH THE REAL ROUTE, because the unit spec proves the predicate and cannot prove it is WIRED.
     * `url` was `z.string().url()` and the relay runs in a task with egress to `0.0.0.0/0`, so every one
     * of these was a queued POST into the VPC — and the failure text is returned by the deliveries
     * endpoint, so the status leaked back to whoever owned the subscription.
     */
    const { status, body } = await attempt(url);

    expect(status, `${url} was accepted: ${body}`).toBe(422);
    // The reason travels with it: "invalid URL" on a well-formed address reads as a bug in the product.
    expect(body).toContain('URL rejected');
  });

  it('still accepts an ordinary public endpoint', async () => {
    // The converse. A guard that refused everything would satisfy every case above.
    const { status, body } = await attempt('https://hooks.example.com/opshub');
    expect(status, body).toBeLessThan(300);
  });

  it('removes a subscription’s queued deliveries with it, rather than orphaning them', async () => {
    const subscriptionId = await createSubscription('e2e: cascade on delete');
    await queueDelivery(subscriptionId);
    await queueDelivery(subscriptionId);
    expect(await deliveryCount(subscriptionId)).toBe(2);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/webhooks/subscriptions/${subscriptionId}`,
      headers: authHeaders(admin),
    });
    expect(deleted.statusCode, deleted.body).toBeLessThan(300);

    /*
     * ZERO, not two. Before the constraint these rows survived the delete and became permanently
     * undeliverable — the relay's INNER JOIN could no longer see them, so they sat `pending` with no
     * attempt ever made and no alarm to raise.
     *
     * CASCADE rather than RESTRICT because a delivery exists only to reach one subscription: with the
     * subscription gone there is nowhere to send it and no way to retry. `active = false` is the
     * non-destructive way to stop a subscription and keep its history.
     */
    expect(await deliveryCount(subscriptionId), 'deliveries were orphaned, not removed').toBe(0);
  });

  it('refuses to queue a delivery for a subscription that does not exist', async () => {
    // The other direction, and the one a cascade test cannot cover: the constraint must also stop an
    // orphan being CREATED, not merely clean one up afterwards.
    const error = await queueDelivery('22222222-2222-7222-8222-222222222222').then(
      () => null,
      (err: unknown) => err,
    );

    expect(error, 'the insert was accepted — there is no constraint').not.toBeNull();
    /*
     * Asserted on the CONSTRAINT NAME, not on "foreign key".
     *
     * Drizzle wraps the driver error, so the top-level message is only `Failed query: insert into …`
     * and the cause carries the detail. Matching the name proves WHICH constraint refused — a generic
     * "some foreign key complained" would also pass if an unrelated one fired, and would pass on a
     * database where this constraint had been replaced by something weaker.
     */
    const chain = [error, (error as { cause?: unknown }).cause]
      .map((e) =>
        e instanceof Error
          ? `${e.message} ${String((e as { detail?: string }).detail ?? '')}`
          : String(e),
      )
      .join(' ');
    expect(chain).toContain('fk_webhook_delivery_subscription');
  });

  it('leaves no orphaned delivery anywhere in the table', async () => {
    /*
     * The migration deletes pre-existing orphans before adding the constraint, because the ALTER
     * cannot validate while they exist. This asserts the end state: whatever this database
     * accumulated before, nothing points at a missing subscription now — and nothing can.
     */
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(webhookDeliveries)
      .where(
        and(
          sql`not exists (select 1 from messaging.webhook_subscriptions s where s.id = ${webhookDeliveries.subscriptionId})`,
        ),
      );
    expect(row?.n ?? 0, 'orphaned deliveries remain').toBe(0);
  });
});
