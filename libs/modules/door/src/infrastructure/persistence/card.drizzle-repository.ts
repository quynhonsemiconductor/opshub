import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { InjectDrizzle, type DbExecutor, type DrizzleDB } from '@platform';
import { newId } from '@shared-kernel';
import { cards, employees, events } from '../../../../../../db/schema';
import type {
  AllowListEntry,
  CardCandidate,
  ICardRepository,
  UnknownCardGroup,
} from '../../domain/ports/card.repository';
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

  async listAllowList(): Promise<AllowListEntry[]> {
    // COMPUTED, not cached: join the DIRECTORY at read time, so an offboarded or on-leave employee's
    // cards appear and vanish with the next poll and no hook anywhere has to fire (ADR §2.4). The
    // join is SQL, not a foreign key — the cross-schema rule is about constraints, not reads.
    // Ordered by uid: the response body is the ETag's input, and a stable order is what makes the
    // hash change only when the LIST changes.
    return this.db
      .select({
        uid: cards.uid,
        validFrom: cards.validFrom,
        validUntil: cards.validUntil,
      })
      .from(cards)
      .innerJoin(employees, eq(employees.id, cards.employeeId))
      .where(
        and(
          eq(cards.status, 'active'),
          inArray(employees.status, ['active', 'on_leave']),
          // An expired card is already useless; a not-yet-valid one travels WITH its future
          // valid_from, because the terminal enforces the window offline.
          or(isNull(cards.validUntil), gt(cards.validUntil, sql`now()`)),
        ),
      )
      .orderBy(asc(cards.uid), asc(cards.id));
  }

  async findCardCandidatesByUids(uids: string[]): Promise<CardCandidate[]> {
    if (uids.length === 0) return [];
    // NO status filter (SA review 480/B1): a swipe before a revocation still resolves to the card;
    // the window (valid_from <= t < coalesce(revoked_at, valid_until, infinity)) decides, in the
    // service. Revoked/lost rows are candidates with an end time.
    return this.db
      .select({
        id: cards.id,
        uid: cards.uid,
        validFrom: cards.validFrom,
        validUntil: cards.validUntil,
        revokedAt: cards.revokedAt,
      })
      .from(cards)
      .where(inArray(cards.uid, uids));
  }

  async insertEvents(
    terminalId: string,
    rows: {
      stream: string;
      seq: number;
      reader: 'in' | 'out';
      uid: string;
      result: 'allow' | 'deny';
      cardId: string | null;
      deviceTs: Date;
      timeSynced: boolean;
    }[],
    tx?: DbExecutor,
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const inserted = await (tx ?? this.db)
      .insert(events)
      .values(
        rows.map((r) => ({
          terminalId,
          stream: r.stream,
          seq: r.seq,
          reader: r.reader,
          uid: r.uid,
          result: r.result,
          cardId: r.cardId,
          deviceTs: r.deviceTs,
          timeSynced: r.timeSynced,
        })),
      )
      // The idempotency of the whole protocol: a terminal retrying after a lost response, or a
      // replayed batch, lands here and changes nothing (ADR §2.4). RETURNING tells the caller how
      // many rows were NEW — `dropped` is counted only once, on the batch that inserted (480/S3).
      .onConflictDoNothing({
        target: [events.terminalId, events.stream, events.seq],
      })
      .returning({ id: events.id });
    return inserted.length;
  }
}
