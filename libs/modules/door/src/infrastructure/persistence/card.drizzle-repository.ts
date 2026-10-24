import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { InjectDrizzle, type DbExecutor, type DrizzleDB } from '@platform';
import { newId } from '@shared-kernel';
import { cards, events } from '../../../../../../db/schema';
import type { ICardRepository, UnknownCardGroup } from '../../domain/ports/card.repository';
import type { DoorCard, CreateCardInput, ListCardsFilters } from '../../domain/door.types';

@Injectable()
export class CardDrizzleRepository implements ICardRepository {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  async create(input: CreateCardInput, tx?: DbExecutor): Promise<DoorCard> {
    const [row] = await (tx ?? this.db)
      .insert(cards)
      .values({
        id: newId(),
        employeeId: input.employeeId,
        uid: input.uid,
        label: input.label ?? null,
        validFrom: input.validFrom ?? new Date(),
        validUntil: input.validUntil ?? null,
      })
      .returning();
    return row;
  }

  async findById(id: string): Promise<DoorCard | null> {
    const [row] = await this.db.select().from(cards).where(eq(cards.id, id)).limit(1);
    return row ?? null;
  }

  async findActiveByUid(uid: string): Promise<DoorCard | null> {
    const [row] = await this.db
      .select()
      .from(cards)
      .where(and(eq(cards.uid, uid), eq(cards.status, 'active')))
      .limit(1);
    return row ?? null;
  }

  async update(
    id: string,
    input: Partial<Pick<DoorCard, 'label' | 'status' | 'validFrom' | 'validUntil' | 'revokedAt'>>,
    tx?: DbExecutor,
  ): Promise<DoorCard | null> {
    const [row] = await (tx ?? this.db)
      .update(cards)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(cards.id, id))
      .returning();
    return row ?? null;
  }

  async list(
    filters: ListCardsFilters,
    limit: number,
    offset: number,
  ): Promise<{ rows: DoorCard[]; total: number }> {
    const where = and(
      filters.status ? eq(cards.status, filters.status) : undefined,
      filters.employeeId ? eq(cards.employeeId, filters.employeeId) : undefined,
    );
    const rows = await this.db
      .select()
      .from(cards)
      .where(where)
      // `id` is the total-order tiebreaker (query-ordering ratchet).
      .orderBy(asc(cards.uid), asc(cards.id))
      .limit(limit)
      .offset(offset);
    const [count] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(cards)
      .where(where);
    return { rows, total: count?.count ?? 0 };
  }

  async listUnknownCardGroups(since: Date, limit: number): Promise<UnknownCardGroup[]> {
    const rows = await this.db
      .select({
        uid: events.uid,
        count: sql<number>`count(*)::int`,
        lastSeenAt: sql<Date>`max(${events.receivedAt})`,
        reader: sql<string>`(array_agg(${events.reader} ORDER BY ${events.receivedAt} DESC))[1]`,
        active: sql<number>`bool_or(EXISTS (
          SELECT 1 FROM "door"."cards" c WHERE c.uid = ${events.uid} AND c.status = 'active'
        ))`,
      })
      .from(events)
      // The ONE definition of unknown (ADR §2.5): no card owned the UID at event time, which the
      // insert-time resolution decided — the column says so. The NOT-EXISTS then drops UIDs that
      // have SINCE been enrolled: those are done, not pending HR work.
      .where(and(isNull(events.cardId), gt(events.receivedAt, since)))
      .groupBy(events.uid)
      .orderBy(desc(sql`max(${events.receivedAt})`), asc(events.uid))
      .limit(limit);
    return rows
      .filter((r) => !r.active)
      .map((r) => ({
        uid: r.uid,
        count: r.count,
        lastSeenAt: new Date(r.lastSeenAt),
        reader: r.reader as 'in' | 'out',
      }));
  }
}
