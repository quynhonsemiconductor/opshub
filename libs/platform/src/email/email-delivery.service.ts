/**
 * EmailDeliveryService — the read side of the email feedback loop.
 *
 * Answers "what happened AFTER the provider accepted this email?" for the callers that
 * surface it to a human (an inviter looking at a pending invitation needs to know the
 * link they are waiting on bounced). The write side is BounceFeedbackService in the
 * worker; this service only reads, so the API can depend on it without dragging any
 * queue plumbing along.
 *
 * Matched by IDEMPOTENCY KEY, not message id: callers know the business key they
 * scheduled with (`invitation.id`, `password-reset:<hash>`), while the SES message id
 * is an implementation detail the relay owns. A key's family — `id`, `id:r1`, `id:r2`
 * for resends — is matched with a prefix, and the LATEST row in the family decides,
 * because a resend that delivered supersedes the earlier bounce.
 */
import { Injectable } from '@nestjs/common';
import { desc, like, or, eq } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { InjectDrizzle } from '../database/drizzle.provider';
import type { DrizzleDB } from '../database/drizzle.provider';
import { emailOutbox } from '../../../../db/schema/messaging';

export type EmailDeliveryStatus = 'sent' | 'bounced' | 'complained' | 'failed' | 'unknown';

@Injectable()
export class EmailDeliveryService {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  /**
   * Delivery status per key family. For each `key`, every outbox row whose idempotency
   * key is `key` or `key:rN` (a resend) is considered, and the most recently scheduled
   * row's status wins. Keys with no rows answer `unknown` — includes rows sent before
   * the feedback loop existed, whose verdicts can never arrive.
   */
  async statusesFor(keyRoots: readonly string[]): Promise<Map<string, EmailDeliveryStatus>> {
    const result = new Map<string, EmailDeliveryStatus>();
    if (keyRoots.length === 0) return result;

    // Pre-seeded so every caller gets a total answer: a root with no rows (legacy, or
    // scheduled before the loop existed) is `unknown` here rather than via a fallback
    // each caller has to remember to repeat.
    for (const root of keyRoots) result.set(root, 'unknown');

    // One prefix condition per root, one query. LIKE on an indexed-ish varchar over a
    // page-sized root list is the shape the invitations list actually issues.
    const predicates: SQL[] = keyRoots.map((root) =>
      like(emailOutbox.idempotencyKey, `${root.replace(/[%_]/g, '\\$&')}:%`),
    );
    predicates.push(...keyRoots.map((root) => eq(emailOutbox.idempotencyKey, root)));

    const rows = await this.db
      .select({
        idempotencyKey: emailOutbox.idempotencyKey,
        status: emailOutbox.status,
        scheduledAt: emailOutbox.scheduledAt,
      })
      .from(emailOutbox)
      .where(or(...predicates))
      // id tiebreak per the query-ordering ratchet: two rows scheduled in the same
      // tick must not flip which one reads as "latest" on the next UPDATE.
      .orderBy(desc(emailOutbox.scheduledAt), desc(emailOutbox.id));

    const rootOf = (key: string): string => {
      const suffix = key.lastIndexOf(':r');
      return suffix > 0 ? key.slice(0, suffix) : key;
    };

    // Descending order means the FIRST row seen per root is the latest — later rows for
    // the same root are deliberately skipped, which is the "resend supersedes" rule.
    // `seen` is tracked apart from `result` because every root is PRE-SEEDED with
    // 'unknown': has() alone could never tell "row applied" from "seeded default".
    const seen = new Set<string>();
    for (const row of rows) {
      if (!row.idempotencyKey) continue; // legacy rows carry no key and belong to no family
      const root = rootOf(row.idempotencyKey);
      if (!seen.has(root)) {
        seen.add(root);
        // `pending` = still queued, nothing verdict-worthy has happened; reporting it
        // as unknown keeps the union to states a caller can act on.
        if (row.status === 'pending') result.set(root, 'unknown');
        // `delivered` is the webhook outbox's terminal value on this shared enum, not
        // an email verdict — a row carrying it reads as sent.
        else if (row.status === 'delivered') result.set(root, 'sent');
        else result.set(root, row.status);
      }
    }
    return result;
  }
}
