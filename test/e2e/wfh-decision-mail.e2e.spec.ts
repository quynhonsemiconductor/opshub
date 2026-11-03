/**
 * What a WFH request's decisions actually put in people's mailboxes — the whole chain, from the HTTP call to a
 * dispatched e-mail row.
 *
 * `notification-email-cascade.e2e.spec.ts` proves the cascade works for a notification it enqueues itself. This
 * spec proves the PRODUCT claims about WFH on top of it: that approving, rejecting and letting a request lapse
 * each reach the requester by e-mail with the words they should carry, that the reason for a rejection is in the
 * e-mail, that switching the e-mail off still leaves the in-app notification, and that filing a request reaches
 * the people who may decide it.
 *
 * WHAT IS ASSERTED, AND WHERE. The assertion is on the `email_outbox` row: its recipient, its template, its
 * `sent` status (the provider was invoked) and the title and body it will render — the same `vars` the e-mail
 * is built from. The HTML itself is pinned in `templates/notification.spec.ts`; delivery to a real mailbox is
 * the manual acceptance scenarios (AT-N-01…03).
 *
 * THE RELAYS ARE DRIVEN BY THIS FILE, exactly as in the cascade spec: they only run in the worker, so the spec
 * plays the worker, stops the wake listener so nothing else starts a pass, and calls `relay()` until its own rows
 * settle. Each e-mail is found by the id of the request it is about, which appears in its body.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d`, `pnpm db:migrate` and `pnpm db:seed`.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setProcessRole } from '@platform/config/process-role';
import { and, eq, sql } from 'drizzle-orm';
import {
  DRIZZLE,
  EMAIL_PROVIDER,
  OutboxWakeService,
  RequestEngine,
  type DrizzleDB,
  type IEmailProvider,
} from '@platform';
import { NotificationRelayService } from '../../libs/modules/notifications/src/application/notification-relay.service';
import { EmailRelayService } from '../../libs/modules/notifications/src/application/email-relay.service';
import { NotificationPreferencesService } from '../../libs/modules/notifications/src/application/notification-preferences.service';
import { emailOutbox, notificationOutbox } from '../../db/schema';
import { FIXTURE, apiRequest, createTestApp, login, unwrap, type Session } from './support/harness';
import { mondayAhead, plusDays } from './support/week-dates';
import { giveWeeklyWfhAllowance } from './support/wfh-allowance';

let app: NestFastifyApplication;
let db: DrizzleDB;
let notificationRelay: NotificationRelayService;
let emailRelay: EmailRelayService;
let prefs: NotificationPreferencesService;
let hr: Session;
let approver: Session;
let requester: Session;

/** Unique per run: rank names and role codes are shared across suites. */
const _RUN_TAG = Date.now().toString(36).slice(-6);

/** How many weeks ahead the test days are; clear of the other WFH specs' weeks. */
const _WEEKS_AHEAD = 12;

/** The most passes either relay is driven for; far above any plausible queue, and free when the queue is empty. */
const _MAX_RELAY_PASSES = 400;

interface FiledRequest {
  /** The WFH row's id. */
  id: string;
  /** The approval engine's id for the ticket — what the notifications are about. */
  requestId: string;
}

interface Mail {
  to: string;
  template: string;
  status: string;
  title: string;
  body: string;
}

const monday = mondayAhead(_WEEKS_AHEAD);

beforeAll(async () => {
  app = await createTestApp();
  // The relays only run in the worker; this spec plays it. Restored in afterAll.
  setProcessRole('worker');
  db = app.get<DrizzleDB>(DRIZZLE);
  notificationRelay = app.get(NotificationRelayService);
  emailRelay = app.get(EmailRelayService);
  prefs = app.get(NotificationPreferencesService);
  expect(
    app.get<IEmailProvider>(EMAIL_PROVIDER).constructor.name,
    'this spec must not run against a real email provider',
  ).toBe('DevEmailProvider');
  // So this file is the only thing that starts a relay pass (see the cascade spec for the long story).
  await app.get(OutboxWakeService).onModuleDestroy();

  hr = await login(app, FIXTURE.HR);
  approver = await login(app, FIXTURE.APPROVER);
  requester = await login(app, FIXTURE.SECURITY);
  await giveWeeklyWfhAllowance(app, hr, FIXTURE.SECURITY.id, 5, `mail${_RUN_TAG}`);
}, 60_000);

afterAll(async () => {
  setProcessRole('api');
  await app?.close();
});

/**
 * Files a one-day WFH request as the requester.
 *
 * The API does not expose the approval ticket's id, and every notification is about the TICKET, so it is read
 * back from the WFH row.
 *
 * Args:
 *   day: The `YYYY-MM-DD` day to work from home.
 *
 * Returns:
 *   The WFH row's id and the approval ticket's id.
 */
async function fileWfh(day: string): Promise<FiledRequest> {
  const { status, body } = await apiRequest(app, requester, 'POST', '/workforce/wfh', {
    startDate: day,
    endDate: day,
  });
  expect(status, JSON.stringify(body)).toBe(201);
  const { id } = unwrap<{ id: string }>(body);
  const linked = await db.execute(
    sql`select request_id from workforce.wfh_requests where id = ${id}`,
  );
  const requestId = (linked.rows[0] as { request_id: string } | undefined)?.request_id;
  if (!requestId) throw new Error(`WFH request ${id} has no approval ticket`);
  return { id, requestId };
}

/**
 * Runs the notification relay, then the e-mail relay, until nothing about this request is still pending.
 *
 * Args:
 *   requestId: The approval engine's id for the ticket; every notification about it carries it in its variables.
 */
async function drain(requestId: string): Promise<void> {
  const pendingNotifications = async (): Promise<number> => {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(notificationOutbox)
      .where(
        and(
          eq(notificationOutbox.status, 'pending'),
          sql`${notificationOutbox.vars}->>'requestId' = ${requestId}`,
        ),
      );
    return row?.n ?? 0;
  };
  for (let pass = 0; pass < _MAX_RELAY_PASSES && (await pendingNotifications()) > 0; pass += 1) {
    await notificationRelay.relay();
  }

  const pendingMail = async (): Promise<number> => {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(emailOutbox)
      .where(
        and(
          eq(emailOutbox.status, 'pending'),
          sql`${emailOutbox.vars}->>'body' like ${`%${requestId}%`}`,
        ),
      );
    return row?.n ?? 0;
  };
  for (let pass = 0; pass < _MAX_RELAY_PASSES && (await pendingMail()) > 0; pass += 1) {
    await emailRelay.relay();
  }
}

/** The e-mails about this request that were addressed to `to`. */
async function mailAbout(requestId: string, to: string): Promise<Mail[]> {
  const rows = await db
    .select({
      to: emailOutbox.to,
      template: emailOutbox.template,
      status: emailOutbox.status,
      vars: emailOutbox.vars,
    })
    .from(emailOutbox)
    .where(and(eq(emailOutbox.to, to), sql`${emailOutbox.vars}->>'body' like ${`%${requestId}%`}`));
  return rows.map((row) => ({
    to: row.to,
    template: row.template,
    status: row.status,
    title: String(row.vars['title']),
    body: String(row.vars['body']),
  }));
}

/** The status of the in-app notification pipeline row for a request's decision, by its idempotency key. */
async function notificationStatus(idempotencyKey: string): Promise<string | undefined> {
  const [row] = await db
    .select({ status: notificationOutbox.status })
    .from(notificationOutbox)
    .where(eq(notificationOutbox.idempotencyKey, idempotencyKey));
  return row?.status;
}

describe('the e-mails a WFH request leads to', () => {
  it('tells the requester an approval, and the sender is not left guessing: it is sent', async () => {
    const { id, requestId } = await fileWfh(monday);

    const review = await apiRequest(app, approver, 'POST', `/workforce/wfh/${id}/review`, {
      approve: true,
    });
    expect(review.status, JSON.stringify(review.body)).toBeLessThan(300);
    await drain(requestId);

    const mails = await mailAbout(requestId, FIXTURE.SECURITY.email);
    const approved = mails.find((m) => m.title.includes('was approved'));
    expect(approved, JSON.stringify(mails)).toBeDefined();
    expect(approved!.template).toBe('notification');
    expect(approved!.title).toBe('Your wfh_request request was approved');
    // Dispatched, not merely queued.
    expect(approved!.status).toBe('sent');
  });

  it('tells the requester a rejection, with the reason the decider gave', async () => {
    const { id, requestId } = await fileWfh(plusDays(monday, 1));

    const review = await apiRequest(app, approver, 'POST', `/workforce/wfh/${id}/review`, {
      approve: false,
      note: 'the team is short that week',
    });
    expect(review.status, JSON.stringify(review.body)).toBeLessThan(300);
    await drain(requestId);

    const rejected = (await mailAbout(requestId, FIXTURE.SECURITY.email)).find((m) =>
      m.title.includes('was rejected'),
    );
    expect(rejected, 'no rejection e-mail').toBeDefined();
    expect(rejected!.title).toBe('Your wfh_request request was rejected');
    expect(rejected!.body).toContain('the team is short that week');
    expect(rejected!.status).toBe('sent');
  });

  it('tells the requester when the request lapses without a decision', async () => {
    const { requestId } = await fileWfh(plusDays(monday, 2));

    // What the worker's expiry job calls once a request is past its 72 hours.
    await app.get(RequestEngine).expire(requestId);
    await drain(requestId);

    const expired = (await mailAbout(requestId, FIXTURE.SECURITY.email)).find((m) =>
      m.title.includes('expired'),
    );
    expect(expired, 'no expiry e-mail').toBeDefined();
    expect(expired!.title).toBe('Your wfh_request request expired');
    expect(expired!.body).toContain('not approved');
    expect(expired!.status).toBe('sent');
  });

  it('sends no e-mail when the requester switched it off, but still delivers in-app', async () => {
    const { id, requestId } = await fileWfh(plusDays(monday, 3));
    await prefs.upsert({
      userId: FIXTURE.SECURITY.id,
      type: 'request.approved',
      inApp: true,
      email: false,
    });
    try {
      const review = await apiRequest(app, approver, 'POST', `/workforce/wfh/${id}/review`, {
        approve: true,
      });
      expect(review.status, JSON.stringify(review.body)).toBeLessThan(300);
      await drain(requestId);

      expect(
        await mailAbout(requestId, FIXTURE.SECURITY.email),
        'an e-mail was queued against the recipient’s preference',
      ).toEqual([]);
      expect(await notificationStatus(`request_approved:${requestId}`)).toBe('sent');
    } finally {
      await prefs.reset(FIXTURE.SECURITY.id, 'request.approved');
    }
  });

  it('reaches the people who may decide when a request is filed', async () => {
    const { requestId } = await fileWfh(plusDays(monday, 4));
    await drain(requestId);

    // The requester has no manager, so the ticket is open to every holder of the review permission, and the
    // general approver group is one of them.
    const mails = await mailAbout(requestId, FIXTURE.APPROVER.email);
    const awaiting = mails.find((m) => m.title.includes('awaiting review'));
    expect(awaiting, JSON.stringify(mails)).toBeDefined();
    expect(awaiting!.title).toBe('New wfh_request request awaiting review');
    expect(awaiting!.body).toContain(FIXTURE.SECURITY.email);
  });
});
