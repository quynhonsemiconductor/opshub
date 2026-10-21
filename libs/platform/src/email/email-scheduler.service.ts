import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { type DrizzleDB, type DbExecutor } from '../database/drizzle.provider';
import { emailOutbox } from '../../../../db/schema';
import { type EmailTemplateName, type EmailTemplateVars } from './templates';
import { EMAIL_WAKE, notifyOutbox } from '../outbox/outbox-wake';

/**
 * EmailSchedulerService — enqueue an email into email_outbox inside the
 * caller's existing DB transaction.
 *
 * The relay (EmailRelayService in the notifications module) reads these rows
 * every 5 s and calls EmailService.sendTemplate().
 */
@Injectable()
export class EmailSchedulerService {
  async schedule<K extends EmailTemplateName>(
    tx: DbExecutor,
    to: string,
    template: K,
    vars: EmailTemplateVars[K],
    opts?: {
      idempotencyKey?: string;
      scheduledAt?: Date;
      /**
       * The internal user this email is for.
       *
       * `email_outbox.recipient_id` has existed since the table was created, with a docblock saying it
       * is "used to check notification_preferences before sending" — and no way to populate it, because
       * this method never accepted one. So the column was always NULL and any send-time preference
       * check reading it was unreachable. The sibling repo has that exact dead branch.
       */
      recipientId?: string;
    },
  ): Promise<void> {
    // Both DrizzleDB and DrizzleTx expose .insert(); cast to narrow the overload.
    await (tx as DrizzleDB)
      .insert(emailOutbox)
      .values({
        to,
        template,
        vars: vars as Record<string, unknown>,
        status: 'pending',
        idempotencyKey: opts?.idempotencyKey ?? null,
        recipientId: opts?.recipientId ?? null,
        // Omitted unless the caller has a time to keep: the column default is the database's now() (the Time rule,
        // .github#29). The relay claims with the database's now() too.
        scheduledAt: opts?.scheduledAt,
      })
      /*
       * THE INDEX IS PARTIAL, so the conflict target must carry its predicate.
       *
       * `uq_email_outbox_idempotency` is `UNIQUE (idempotency_key) WHERE idempotency_key IS NOT NULL`,
       * and Postgres will not infer a partial index from the column alone — it raises "there is no
       * unique or exclusion constraint matching the ON CONFLICT specification" and aborts the
       * transaction. So this method has never worked: every call would have thrown on its first insert.
       *
       * Nothing noticed because nothing called it. The email pipeline was not merely unwired — the one
       * function that would have wired it was broken, and the first thing the cascade's e2e test did was
       * fail on this.
       */
      .onConflictDoNothing({
        target: emailOutbox.idempotencyKey,
        // On `onConflictDoNothing` this version of drizzle emits `where` as the conflict TARGET
        // predicate — `ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING` —
        // which is the inference clause a partial index needs. `targetWhere` exists only on
        // `onConflictDoUpdate`.
        where: sql`${emailOutbox.idempotencyKey} IS NOT NULL`,
      });

    // The wake hint, in the caller's transaction: delivered at commit. Polling stays the source of truth.
    await notifyOutbox(tx, EMAIL_WAKE);
  }
}
