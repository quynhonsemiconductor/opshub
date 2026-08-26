/**
 * A notification the recipient wants by email actually becomes an email.
 *
 * THE WHOLE EMAIL HALF OF NOTIFICATIONS WAS DEAD. Nothing anywhere called `EmailSchedulerService`, so
 * `messaging.email_outbox` was always empty, `EmailRelayService` polled it every five seconds forever,
 * the five templates never rendered, `APP_URL` and `MAIL_REPLY_TO` were read nowhere, and
 * `notification_preferences.email` — a column defaulting to `true`, with a UI switch in front of it —
 * was honoured nowhere. Anybody who left the box ticked got silence, and no test in the repository so
 * much as mentioned `email_outbox`.
 *
 * WHY THIS TEST IS THE POINT OF THE CHANGE. A dead pipeline is invisible to unit tests: every piece
 * passes its own spec in isolation, because each one works. What was missing was the CALL between them,
 * and the only thing that catches a missing call is a test that drives the whole chain. So this one
 * boots the real relays against the real database and follows one notification from outbox row to a
 * dispatched email.
 *
 * WHAT `status='sent'` PROVES, and what it does not. It proves the provider was invoked and returned:
 * `EmailService.sendTemplate` has no branch that skips `provider.send`, and a throw would have gone to
 * `markFailed` instead. (I first assumed otherwise and criticised the sibling repo's equivalent
 * assertion for being weak — it is not.) What it does NOT pin is the rendered payload, so that is
 * asserted in `templates/notification.spec.ts` instead of here.
 *
 * An earlier draft spied the provider in this file and asserted the payload directly. It failed about
 * one run in three, always on that one assertion and never on a database assertion, and the provider
 * instance was verifiably the right one — so the send was landing outside the window the assertion
 * could see. A flaky assertion is worse than none: it trains people to re-run instead of read. The
 * deterministic half lives here, the payload half lives in a unit test.
 *
 * Prereqs: `docker compose -f docker-compose.dev.yml up -d` and `pnpm db:seed`.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE, EMAIL_PROVIDER, type DrizzleDB, type IEmailProvider } from '@platform';
import { NotificationSchedulerService } from '@platform';
import { NotificationRelayService } from '../../libs/modules/notifications/src/application/notification-relay.service';
import { EmailRelayService } from '../../libs/modules/notifications/src/application/email-relay.service';
import { NotificationPreferencesService } from '../../libs/modules/notifications/src/application/notification-preferences.service';
import { emailOutbox, notificationOutbox } from '../../db/schema';
import { FIXTURE, createTestApp } from './support/harness';

let app: NestFastifyApplication;
let db: DrizzleDB;
let scheduler: NotificationSchedulerService;
let notificationRelay: NotificationRelayService;
let emailRelay: EmailRelayService;
let prefs: NotificationPreferencesService;
let provider: IEmailProvider;

/** The notification type these cases use. Real, so the preference lookup is the real one. */
const TYPE = 'request.submitted';

beforeAll(async () => {
  app = await createTestApp();
  db = app.get<DrizzleDB>(DRIZZLE);
  scheduler = app.get(NotificationSchedulerService);
  notificationRelay = app.get(NotificationRelayService);
  emailRelay = app.get(EmailRelayService);
  prefs = app.get(NotificationPreferencesService);
  // The dev provider, which logs instead of sending. Held so this spec never reaches a real mailbox
  // even if EMAIL_PROVIDER is misconfigured in a developer's environment.
  provider = app.get<IEmailProvider>(EMAIL_PROVIDER);
  expect(provider.constructor.name, 'this spec must not run against a real email provider').toBe(
    'DevEmailProvider',
  );

  /*
   * DROP THE WAKE SUBSCRIPTIONS, so this spec is the only thing that makes a relay run.
   *
   * Both relays subscribe to a Valkey wake channel in `onModuleInit`, and every enqueue publishes to
   * it — so a pass can start at any moment, including inside another relay's post-commit window. With
   * that running, no arrangement of explicit `relay()` calls is deterministic: work lands in a pass this
   * file did not start, at a moment it cannot predict. I watched that produce three different outcomes
   * across three identical runs.
   *
   * `onModuleDestroy` unsubscribes and leaves the objects fully usable, which is exactly what is
   * wanted: the cron is worker-only, so with the wake channel gone the ONLY driver is this file. The
   * production path is unchanged and still covered — `relay()` is the same method the cron calls.
   */
  await notificationRelay.onModuleDestroy();
  await emailRelay.onModuleDestroy();
});

afterAll(async () => {
  await app?.close();
});

/** Enqueue one notification for `recipientId`, run both relays, and return the `email_outbox` rows. */
async function deliver(recipientId: string): Promise<{
  emails: { to: string; template: string; status: string; recipientId: string | null }[];
  /** The unique key this call enqueued under, so a test can find its own row and nothing else. */
  marker: string;
}> {
  const marker = `e2e-cascade-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await db.transaction(async (tx) => {
    await scheduler.schedule(tx, {
      type: TYPE,
      // `request.submitted` renders from these; the marker rides along so the row is findable.
      vars: { requestType: marker, requesterName: 'E2E Requester' } as never,
      recipientId,
      idempotencyKey: marker,
    });
  });

  /*
   * Driven directly rather than waiting for the 5s cron. Called TWICE each because a wake-triggered
   * pass can be mid-flight when the first call arrives: `relay()` coalesces by awaiting a pass that
   * starts after the caller, so two calls guarantee one full pass over rows committed by the previous
   * stage. Both relays claim with FOR UPDATE SKIP LOCKED, so extra passes are harmless.
   */
  /*
   * DRIVEN UNTIL THIS ROW IS DONE, not a fixed number of passes.
   *
   * A relay claims at most `batchSize` rows per pass, ordered by `scheduled_at`. Run alone this file's
   * row is the only one and a single pass suffices — but in the full suite other specs leave dozens of
   * notifications behind, so one pass need not reach ours. That is what made this fail only when run
   * with everything else, which is the worst way for a test to fail.
   *
   * Bounded, and each iteration is a real pass over real rows: `relay()` is the same method the cron
   * calls, and both relays claim with FOR UPDATE SKIP LOCKED, so extra passes are harmless.
   */
  const settled = async (): Promise<boolean> => {
    const [row] = await db
      .select({ status: notificationOutbox.status })
      .from(notificationOutbox)
      .where(eq(notificationOutbox.idempotencyKey, marker));
    return row?.status !== 'pending';
  };

  /*
   * DRIVEN UNTIL THIS ROW SETTLES, with a cap far above any plausible queue.
   *
   * A relay claims at most `batchSize` rows per pass ordered by `scheduled_at`, and this row sits
   * behind everything the rest of the suite has queued. Thirty passes was enough until it was not: a
   * few more specs filing leave — each raising a notification — pushed the row past the horizon, and
   * the failure read "no email_outbox row was created", which sounds like a broken cascade rather than
   * a deep queue.
   *
   * NOT bounded by progress, which I tried first and which is subtly wrong: a pass that moves nothing
   * does not mean this row will never be claimed, because rows that failed are rescheduled into the
   * future and leave the head of the queue as they go. The only honest exit conditions are "our row is
   * no longer pending" and "we have tried far more times than the queue could possibly require".
   *
   * A pass over an empty queue is a single SELECT, so the high cap costs nothing when there is nothing
   * to do.
   */
  for (let pass = 0; pass < 400 && !(await settled()); pass += 1) {
    await notificationRelay.relay();
  }

  // Then the email side. Its row, if any, was enqueued by the pass above. Same reasoning as above:
  // the email queue carries every other spec's mail too.
  for (let pass = 0; pass < 200; pass += 1) {
    await emailRelay.relay();
    const [pending] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(emailOutbox)
      .where(eq(emailOutbox.status, 'pending'));
    if ((pending?.n ?? 0) === 0) break;
  }

  /*
   * FOUND THROUGH THE CHAIN, not by recipient.
   *
   * Filtering `email_outbox` by `recipient_id` picked up rows other specs had created for the same
   * seeded fixture — the suite shares one database, and these fixtures receive notifications from
   * several other files. This walks the actual chain instead: the marker identifies the outbox row,
   * `source_event_id` identifies the in-app notification it produced, and the email's key is
   * `notification-email:<that id>`. Exactly this call's row, whatever else is in the table.
   */
  const emails = await db
    .select({
      to: emailOutbox.to,
      template: emailOutbox.template,
      status: emailOutbox.status,
      recipientId: emailOutbox.recipientId,
    })
    .from(emailOutbox)
    .where(
      sql`${emailOutbox.idempotencyKey} = 'notification-email:' || (
            select n.id::text from notifications.in_app_notifications n
            where n.source_event_id = (
              select o.id from messaging.notification_outbox o where o.idempotency_key = ${marker}
            )
          )`,
    );

  const mine = emails;
  return { emails: mine, marker };
}

describe('a notification becomes an email', () => {
  it('schedules and dispatches an email when the recipient wants one', async () => {
    // No preference row for this type: the default is opt-IN, so email is wanted without any setup.
    const { emails } = await deliver(FIXTURE.HR.id);

    expect(emails.length, 'no email_outbox row was created').toBeGreaterThan(0);
    const email = emails[0];

    // The GENERIC template, deliberately: fifteen notification types, five bespoke templates whose
    // names do not even correspond, so the cascade renders what the bell already shows.
    expect(email.template).toBe('notification');
    expect(email.to).toBe(FIXTURE.HR.email);
    /*
     * `recipient_id` POPULATED. The column has existed since the table was created, documented as
     * "used to check notification_preferences before sending", and the scheduler had no way to set it —
     * so it was always NULL and any send-time check reading it was unreachable. The sibling repo has
     * that exact dead branch.
     */
    expect(email.recipientId).toBe(FIXTURE.HR.id);
    // Dispatched, not merely enqueued.
    expect(email.status).toBe('sent');

    // `sent` is the dispatch proof: the relay called the provider and it returned without throwing.
    // The rendered payload is pinned in `templates/notification.spec.ts`.
  });

  it('schedules no email when the recipient has turned that type off', async () => {
    await prefs.upsert({ userId: FIXTURE.AUDITOR.id, type: TYPE, inApp: true, email: false });

    const { emails } = await deliver(FIXTURE.AUDITOR.id);

    // The negative case, and it has to be here: without it, a cascade that ignored preferences
    // entirely would pass the test above perfectly.
    expect(emails, 'an email was scheduled against the recipient’s preference').toEqual([]);
  });

  it('still delivers in-app when only email is turned off', async () => {
    /*
     * The two channels are independent. Suppressing email must not suppress the notification itself —
     * the relay checks each preference separately, and conflating them would silence the bell too.
     *
     * ASSERTED ON THIS CALL'S OWN ROW, found by its unique key. An earlier version counted `sent` rows
     * per recipient before and after, which couples the case to every other case that touches the same
     * fixture — and made the suite fail occasionally for reasons that had nothing to do with the
     * behaviour under test.
     */
    const { marker } = await deliver(FIXTURE.AUDITOR.id);

    const [row] = await db
      .select({ status: notificationOutbox.status })
      .from(notificationOutbox)
      .where(eq(notificationOutbox.idempotencyKey, marker));

    expect(row?.status, 'the in-app notification was not dispatched').toBe('sent');
  });

  it('sends one email per notification, however often the relay re-runs', async () => {
    const { emails, marker } = await deliver(FIXTURE.SECURITY.id);
    expect(emails.length).toBe(1);

    // Re-running both relays must not produce a second email for the same notification. The key is
    // `notification-email:<notificationId>`, and the notification itself is deduplicated by
    // `source_event_id` — so a replayed outbox row cannot reach the scheduler twice, and
    // `uq_email_outbox_idempotency` refuses it even if it did.
    await notificationRelay.relay();
    await emailRelay.relay();

    // Scoped to THIS notification's key, so rows other specs queued for the same fixture cannot
    // make the count wrong in either direction.
    const [after] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(emailOutbox)
      .where(
        sql`${emailOutbox.idempotencyKey} = 'notification-email:' || (
              select n.id::text from notifications.in_app_notifications n
              where n.source_event_id = (
                select o.id from messaging.notification_outbox o where o.idempotency_key = ${marker}
              )
            )`,
      );
    expect(after?.n ?? 0, 'a second email was queued for the same notification').toBe(1);
  });
});
