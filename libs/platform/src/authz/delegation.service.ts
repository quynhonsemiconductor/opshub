import { Injectable } from '@nestjs/common';
import { and, eq, gt, lte } from 'drizzle-orm';
import { newId } from '@shared-kernel';
import { InjectDrizzle, type DrizzleDB } from '../database/drizzle.provider';
import { approvalDelegations } from '../../../../db/schema';
import { NotFoundException, PreconditionFailedException } from '../errors/exceptions';
import { NotificationSchedulerService } from '../notifications/notification-scheduler.service';
import { nameOf, resolveEmployeeNames } from '../directory/employee-names';

export interface ApprovalDelegation {
  id: string;
  fromUserId: string;
  toUserId: string;
  startsAt: Date;
  endsAt: Date;
  reason: string | null;
  createdAt: Date;
}

export interface CreateDelegationInput {
  fromUserId: string;
  toUserId: string;
  startsAt: Date;
  endsAt: Date;
  reason?: string | null;
}

/**
 * DelegationService manages approval-delegation grants.
 *
 * A delegation lets user A ("from") authorize user B ("to") to approve
 * requests on A's behalf during a specified time window. Typical use case:
 * out-of-office vacation coverage.
 *
 * The RequestEngine calls `findActiveDelegationTo()` on every `approve()` so
 * that delegates can approve without holding the formal permission themselves
 * (permission is inherited from the delegator).
 *
 * Lives in the global PlatformModule — no additional imports needed.
 */
@Injectable()
export class DelegationService {
  constructor(
    @InjectDrizzle() private readonly db: DrizzleDB,
    private readonly notifScheduler: NotificationSchedulerService,
  ) {}

  /**
   * Create a new approval delegation. The window must start before it ends
   * and `toUserId` must differ from `fromUserId`.
   */
  async create(input: CreateDelegationInput): Promise<ApprovalDelegation> {
    if (input.fromUserId === input.toUserId) {
      throw new PreconditionFailedException(
        'DELEGATION_SELF',
        'Cannot delegate approvals to yourself',
      );
    }
    if (input.startsAt >= input.endsAt) {
      throw new PreconditionFailedException(
        'DELEGATION_INVALID_WINDOW',
        'Delegation start must be before end',
      );
    }
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(approvalDelegations)
        .values({
          id: newId(),
          fromUserId: input.fromUserId,
          toUserId: input.toUserId,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          reason: input.reason ?? null,
        })
        .returning();

      /*
       * TELL THE DELEGATE. You cannot use authority you do not know you have.
       *
       * `request.delegation_created` had a template and a variable shape and NO SENDER — nothing
       * anywhere scheduled it, so a delegation appeared silently and the only way to discover it was
       * to notice extra rows in your queue. The delegator knows; they made the grant. The person who
       * now has to act on somebody else's behalf, during a window that expires, was the one nobody
       * told.
       *
       * INSIDE THE INSERT'S TRANSACTION, so a delegation cannot exist without its notification
       * enqueued: the scheduler writes to an outbox row that the relay picks up, and rolling both
       * back together is the only way the two cannot disagree.
       *
       * The delegator's NAME, not their id — the whole point of the sentence is which colleague
       * handed this over, and a uuid identifies nobody. `resolveEmployeeNames` is the batched
       * resolver the rest of the codebase uses; `nameOf` returns null rather than the id when the
       * lookup misses, so an unresolvable delegator degrades to a nameless sentence instead of
       * thirty-six hex characters.
       */
      const names = await resolveEmployeeNames(tx, [input.fromUserId]);
      await this.notifScheduler.schedule(tx, {
        type: 'request.delegation_created',
        vars: {
          delegatorName: nameOf(names, input.fromUserId) ?? 'A colleague',
          endsAt: input.endsAt.toISOString(),
        },
        recipientId: input.toUserId,
        actorId: input.fromUserId,
        resourceId: row.id,
        idempotencyKey: `delegation_created:${row.id}`,
      });

      return row;
    });
  }

  /**
   * Revoke a delegation. Only the delegating user (`fromUserId`) or a
   * platform admin should be able to do this; enforce ownership in the caller.
   */
  async revoke(id: string, actorId: string): Promise<void> {
    const [row] = await this.db
      .select()
      .from(approvalDelegations)
      .where(eq(approvalDelegations.id, id))
      .limit(1);

    if (!row) {
      throw new NotFoundException('DELEGATION_NOT_FOUND', 'Delegation not found');
    }
    if (row.fromUserId !== actorId) {
      throw new PreconditionFailedException(
        'DELEGATION_NOT_OWNER',
        'Only the delegating user can revoke this delegation',
      );
    }

    await this.db.delete(approvalDelegations).where(eq(approvalDelegations.id, id));
  }

  /** List all delegations created BY a user (outgoing). */
  async listFrom(fromUserId: string): Promise<ApprovalDelegation[]> {
    const rows = await this.db
      .select()
      .from(approvalDelegations)
      .where(eq(approvalDelegations.fromUserId, fromUserId));
    return rows;
  }

  /** List all delegations received BY a user (incoming). */
  async listTo(toUserId: string): Promise<ApprovalDelegation[]> {
    const rows = await this.db
      .select()
      .from(approvalDelegations)
      .where(eq(approvalDelegations.toUserId, toUserId));
    return rows;
  }

  /**
   * Find the first active delegation whose `toUserId = actorId` and whose
   * window covers right now. Returns null if the actor is not acting as a delegate.
   *
   * Called by `RequestEngine.approve()` to determine delegation context.
   */
  async findActiveDelegationTo(actorId: string): Promise<ApprovalDelegation | null> {
    const now = new Date();
    const [row] = await this.db
      .select()
      .from(approvalDelegations)
      .where(
        and(
          eq(approvalDelegations.toUserId, actorId),
          lte(approvalDelegations.startsAt, now),
          gt(approvalDelegations.endsAt, now),
        ),
      )
      .limit(1);
    return row ? row : null;
  }

  /** Purge delegations whose window ended before `before`. Called by the expiry cron. */
  async deleteExpiredBefore(before: Date): Promise<number> {
    const result = await this.db
      .delete(approvalDelegations)
      .where(lte(approvalDelegations.endsAt, before));
    return (result as unknown as { rowCount: number }).rowCount ?? 0;
  }
}
