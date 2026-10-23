import { Injectable } from '@nestjs/common';
<<<<<<< HEAD
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
=======
import { and, asc, eq, gte, isNull, sql } from 'drizzle-orm';
>>>>>>> 0d963cd (feat(door): terminal routes — token guard, allow-list ETag, event ingestion, jobs)
import { InjectDrizzle, type DbExecutor, type DrizzleDB } from '@platform';
import { terminals } from '../../../../../../db/schema';
import type { ITerminalRepository } from '../../domain/ports/terminal.repository';
import type { DoorTerminal, CreateTerminalInput } from '../../domain/door.types';

@Injectable()
export class TerminalDrizzleRepository implements ITerminalRepository {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  async create(
    input: CreateTerminalInput & { id: string; tokenHash: string },
    tx?: DbExecutor,
  ): Promise<DoorTerminal> {
    const [row] = await (tx ?? this.db)
      .insert(terminals)
      .values({
        id: input.id,
        name: input.name,
        location: input.location ?? null,
        tokenHash: input.tokenHash,
      })
      .returning();
    return row;
  }

  async findById(id: string): Promise<DoorTerminal | null> {
    const [row] = await this.db.select().from(terminals).where(eq(terminals.id, id)).limit(1);
    return row ?? null;
  }

  async touchLastSeen(id: string, at: Date): Promise<void> {
    await this.db.update(terminals).set({ lastSeenAt: at }).where(eq(terminals.id, id));
  }

  async setTokenHash(id: string, tokenHash: string, tx?: DbExecutor): Promise<DoorTerminal | null> {
    const [row] = await (tx ?? this.db)
      .update(terminals)
      .set({ tokenHash, updatedAt: new Date() })
      // Conditional on revoked_at IS NULL: a revoke racing the rotation wins.
      .where(and(eq(terminals.id, id), isNull(terminals.revokedAt)))
      .returning();
    return row ?? null;
  }

  async revoke(id: string, revokedAt: Date, tx?: DbExecutor): Promise<DoorTerminal | null> {
    const [row] = await (tx ?? this.db)
      .update(terminals)
      .set({ revokedAt, updatedAt: new Date() })
      // Conditional: a concurrent revoke makes this a no-op, never a backdated second stamp.
      .where(and(eq(terminals.id, id), isNull(terminals.revokedAt)))
      .returning();
    return row ?? null;
  }

  async list(): Promise<DoorTerminal[]> {
    // `id` as the tiebreaker is the query-ordering ratchet's rule; `name` alone can tie.
    return this.db.select().from(terminals).orderBy(asc(terminals.name), asc(terminals.id));
  }

  async countActive(): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(terminals)
      .where(isNull(terminals.revokedAt));
    return row?.count ?? 0;
  }

  async countActiveSeenSince(since: Date): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(terminals)
      .where(and(isNull(terminals.revokedAt), gte(terminals.lastSeenAt, since)));
    return row?.count ?? 0;
  }

  async addDropped(id: string, count: number, tx?: DbExecutor): Promise<void> {
    if (count <= 0) return;
    await (tx ?? this.db)
      .update(terminals)
      .set({ droppedEvents: sql`${terminals.droppedEvents} + ${count}` })
      .where(eq(terminals.id, id));
  }
}
