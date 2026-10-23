import { Injectable } from '@nestjs/common';
import { asc, eq, isNull, sql } from 'drizzle-orm';
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
      .where(eq(terminals.id, id))
      .returning();
    return row ?? null;
  }

  async revoke(id: string, revokedAt: Date, tx?: DbExecutor): Promise<DoorTerminal | null> {
    const [row] = await (tx ?? this.db)
      .update(terminals)
      .set({ revokedAt, updatedAt: new Date() })
      .where(eq(terminals.id, id))
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
}
