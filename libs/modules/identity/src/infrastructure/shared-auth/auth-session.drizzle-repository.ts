import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { InjectDrizzle, type DrizzleDB, type DbExecutor } from '@platform';
import type { AuthSession, CreateSessionInput, IAuthSessionRepository } from '@quynhonsemiconductor/identity';
import { refreshTokens } from '../../../../../../db/schema';

type RefreshTokenRow = typeof refreshTokens.$inferSelect;

function toAuthSession(row: RefreshTokenRow): AuthSession {
  return {
    id: row.id,
    contextId: row.contextId,
    userId: row.employeeId,
    tokenHash: row.tokenHash,
    familyId: row.familyId,
    isRevoked: row.revoked,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    ssoProvider: row.ssoProvider,
    csrfToken: row.csrfToken,
  };
}

/**
 * opshub binding for the shared `IAuthSessionRepository` port, backed by the
 * `refresh_tokens` table. Maps the package's `AuthSession` vocabulary onto
 * opshub columns (`userId` → `employee_id`, `isRevoked` → `revoked`). opshub is
 * single-tenant so `context_id` is always null.
 */
@Injectable()
export class AuthSessionDrizzleRepository implements IAuthSessionRepository<DbExecutor> {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  async findByTokenHash(hash: string): Promise<AuthSession | null> {
    const [row] = await this.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hash))
      .limit(1);
    return row ? toAuthSession(row) : null;
  }

  async create(input: CreateSessionInput, tx?: DbExecutor): Promise<void> {
    const db = tx ?? this.db;
    await db.insert(refreshTokens).values({
      id: input.id,
      employeeId: input.userId,
      tokenHash: input.tokenHash,
      familyId: input.familyId,
      authMethod: 'sso',
      contextId: input.contextId ?? null,
      ssoProvider: input.ssoProvider ?? null,
      csrfToken: input.csrfToken ?? null,
      expiresAt: input.expiresAt,
    });
  }

  async revokeById(id: string, tx?: DbExecutor): Promise<void> {
    const db = tx ?? this.db;
    await db.update(refreshTokens).set({ revoked: true }).where(eq(refreshTokens.id, id));
  }

  async revokeByIdIfActive(id: string, tx?: DbExecutor): Promise<boolean> {
    // Conditional update = optimistic compare-and-swap. Only the request that
    // observes revoked=false flips it and gets a row back; concurrent racers get
    // zero rows and must not mint a competing token.
    const db = tx ?? this.db;
    const rows = await db
      .update(refreshTokens)
      .set({ revoked: true })
      .where(and(eq(refreshTokens.id, id), eq(refreshTokens.revoked, false)))
      .returning({ id: refreshTokens.id });
    return rows.length > 0;
  }

  async revokeFamily(familyId: string, tx?: DbExecutor): Promise<void> {
    const db = tx ?? this.db;
    await db
      .update(refreshTokens)
      .set({ revoked: true })
      .where(eq(refreshTokens.familyId, familyId));
  }

  async revokeAllForUser(userId: string, tx?: DbExecutor): Promise<void> {
    const db = tx ?? this.db;
    await db
      .update(refreshTokens)
      .set({ revoked: true })
      .where(eq(refreshTokens.employeeId, userId));
  }
}
