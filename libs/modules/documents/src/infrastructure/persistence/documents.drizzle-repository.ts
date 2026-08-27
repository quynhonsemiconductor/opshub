import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, notExists, sql } from 'drizzle-orm';
import { InjectDrizzle, type DbExecutor, type DrizzleDB, searchAcross } from '@platform';
import { newId } from '@shared-kernel';
import { documentAcknowledgements, documentVersions, documents } from '../../../../../../db/schema';
import type { IDocumentsRepository } from '../../domain/ports/documents.repository';
import type {
  ControlledDocument,
  CreateDocumentInput,
  DocumentFilters,
  DocumentVersion,
  DocumentVersionStatus,
  OutstandingAcknowledgement,
} from '../../domain/documents.types';

@Injectable()
export class DocumentsDrizzleRepository implements IDocumentsRepository {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  // ── Documents ────────────────────────────────────────────────────────────────

  async create(input: CreateDocumentInput, tx?: DbExecutor): Promise<ControlledDocument> {
    const [row] = await (tx ?? this.db)
      .insert(documents)
      .values({
        id: newId(),
        code: input.code,
        title: input.title,
        category: input.category,
        ownerId: input.ownerId,
      })
      .returning();
    return row;
  }

  async findExistingIds(ids: string[]): Promise<string[]> {
    // `inArray(col, [])` is not valid SQL, so an empty list must not reach the database at all.
    if (ids.length === 0) return [];
    const rows = await this.db
      .select({ id: documents.id })
      .from(documents)
      .where(inArray(documents.id, ids));
    return rows.map((row) => row.id);
  }

  async findById(id: string): Promise<ControlledDocument | null> {
    const [row] = await this.db.select().from(documents).where(eq(documents.id, id)).limit(1);
    return row ?? null;
  }

  async findByCode(code: string): Promise<ControlledDocument | null> {
    const [row] = await this.db.select().from(documents).where(eq(documents.code, code)).limit(1);
    return row ?? null;
  }

  async list(
    filters: DocumentFilters,
    limit: number,
    offset: number,
  ): Promise<{ rows: ControlledDocument[]; total: number }> {
    const where = and(
      filters.category ? eq(documents.category, filters.category) : undefined,
      filters.ownerId ? eq(documents.ownerId, filters.ownerId) : undefined,
      // Retired documents stay readable but are out of the way unless asked for.
      filters.includeRetired ? undefined : isNull(documents.retiredAt),
      searchAcross(filters.search, documents.code, documents.title),
    );

    const rows = await this.db
      .select()
      .from(documents)
      .where(where)
      // `code` is unique, so `code` alone is already a total order — the trailing `id` is for the
      // ratchet, which reads source text and cannot see a unique index. Harmless, and it keeps the
      // guarantee true if `code` ever stops being unique.
      .orderBy(asc(documents.code), asc(documents.id))
      .limit(limit)
      .offset(offset);

    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(documents)
      .where(where);

    return { rows, total: count };
  }

  async retire(id: string, tx?: DbExecutor): Promise<boolean> {
    const rows = await (tx ?? this.db)
      .update(documents)
      .set({ retiredAt: new Date(), updatedAt: new Date() })
      .where(and(eq(documents.id, id), isNull(documents.retiredAt)))
      .returning({ id: documents.id });
    return rows.length > 0;
  }

  // ── Versions ─────────────────────────────────────────────────────────────────

  async createVersion(
    input: {
      documentId: string;
      version: number;
      body?: string | null;
      changeSummary?: string | null;
    },
    tx?: DbExecutor,
  ): Promise<DocumentVersion> {
    const [row] = await (tx ?? this.db)
      .insert(documentVersions)
      .values({
        id: newId(),
        documentId: input.documentId,
        version: input.version,
        body: input.body ?? null,
        changeSummary: input.changeSummary ?? null,
      })
      .returning();
    return row;
  }

  async findVersionById(id: string): Promise<DocumentVersion | null> {
    const [row] = await this.db
      .select()
      .from(documentVersions)
      .where(eq(documentVersions.id, id))
      .limit(1);
    return row ?? null;
  }

  async listVersions(documentId: string): Promise<DocumentVersion[]> {
    return (
      this.db
        .select()
        .from(documentVersions)
        .where(eq(documentVersions.documentId, documentId))
        // (documentId, version) is unique and this query is scoped to one document, so `version`
        // alone is total; `id` is the tiebreaker the ratchet can actually verify.
        .orderBy(desc(documentVersions.version), asc(documentVersions.id))
    );
  }

  async maxVersion(documentId: string, tx?: DbExecutor): Promise<number> {
    const [row] = await (tx ?? this.db)
      .select({ max: sql<number>`coalesce(max(${documentVersions.version}), 0)::int` })
      .from(documentVersions)
      .where(eq(documentVersions.documentId, documentId));
    return row?.max ?? 0;
  }

  async findPublishedVersion(documentId: string, tx?: DbExecutor): Promise<DocumentVersion | null> {
    const [row] = await (tx ?? this.db)
      .select()
      .from(documentVersions)
      .where(
        and(
          eq(documentVersions.documentId, documentId),
          eq(documentVersions.status, 'published'),
          isNull(documentVersions.supersededAt),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async updateVersionContent(
    id: string,
    input: { body?: string | null; changeSummary?: string | null },
    tx?: DbExecutor,
  ): Promise<DocumentVersion | null> {
    const [row] = await (tx ?? this.db)
      .update(documentVersions)
      .set({
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(input.changeSummary !== undefined ? { changeSummary: input.changeSummary } : {}),
      })
      // Draft ONLY. Editing anything further along is refused by the WHERE clause rather than by a
      // read-then-write check, so a concurrent submit cannot slip between the two.
      .where(and(eq(documentVersions.id, id), eq(documentVersions.status, 'draft')))
      .returning();
    return row ?? null;
  }

  async setVersionStatus(
    id: string,
    status: DocumentVersionStatus,
    extra?: {
      requestId?: string | null;
      approvedBy?: string | null;
      approvedAt?: Date | null;
      publishedAt?: Date | null;
      supersededAt?: Date | null;
      reviewDueOn?: string | null;
    },
    tx?: DbExecutor,
  ): Promise<DocumentVersion | null> {
    const [row] = await (tx ?? this.db)
      .update(documentVersions)
      .set({ status, ...(extra ?? {}) })
      .where(eq(documentVersions.id, id))
      .returning();
    return row ?? null;
  }

  // ── Acknowledgements ─────────────────────────────────────────────────────────

  async acknowledge(versionId: string, employeeId: string, tx?: DbExecutor): Promise<boolean> {
    const rows = await (tx ?? this.db)
      .insert(documentAcknowledgements)
      .values({ id: newId(), versionId, employeeId })
      // Idempotent by the unique index, so a double click is one acknowledgement. The returning
      // rows tell the caller whether this was new, which is how a duplicate audit entry is avoided.
      .onConflictDoNothing({
        target: [documentAcknowledgements.versionId, documentAcknowledgements.employeeId],
      })
      .returning({ id: documentAcknowledgements.id });
    return rows.length > 0;
  }

  async hasAcknowledged(versionId: string, employeeId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: documentAcknowledgements.id })
      .from(documentAcknowledgements)
      .where(
        and(
          eq(documentAcknowledgements.versionId, versionId),
          eq(documentAcknowledgements.employeeId, employeeId),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  async listOutstandingFor(employeeId: string): Promise<OutstandingAcknowledgement[]> {
    /**
     * Published, not superseded, and no acknowledgement row for THIS employee against THIS
     * version. `notExists` rather than a LEFT JOIN with an IS NULL filter: the anti-join reads as
     * the question being asked, and cannot accidentally multiply rows if the acknowledgement table
     * ever gains a second row per pair.
     */
    return this.db
      .select({
        documentId: documents.id,
        code: documents.code,
        title: documents.title,
        category: documents.category,
        versionId: documentVersions.id,
        version: documentVersions.version,
        publishedAt: sql<Date>`${documentVersions.publishedAt}`,
      })
      .from(documentVersions)
      .innerJoin(documents, eq(documents.id, documentVersions.documentId))
      .where(
        and(
          eq(documentVersions.status, 'published'),
          isNull(documentVersions.supersededAt),
          // A retired document binds nobody, so it must not appear as outstanding work.
          isNull(documents.retiredAt),
          notExists(
            this.db
              .select({ one: sql`1` })
              .from(documentAcknowledgements)
              .where(
                and(
                  eq(documentAcknowledgements.versionId, documentVersions.id),
                  eq(documentAcknowledgements.employeeId, employeeId),
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(documents.code), asc(documentVersions.id));
  }

  async listAcknowledgedBy(
    versionId: string,
  ): Promise<{ employeeId: string; acknowledgedAt: Date }[]> {
    return (
      this.db
        .select({
          employeeId: documentAcknowledgements.employeeId,
          acknowledgedAt: documentAcknowledgements.acknowledgedAt,
        })
        .from(documentAcknowledgements)
        .where(eq(documentAcknowledgements.versionId, versionId))
        // (versionId, employeeId) is unique, so employeeId already makes this total; `id` is what
        // the ratchet can check.
        .orderBy(asc(documentAcknowledgements.acknowledgedAt), asc(documentAcknowledgements.id))
    );
  }
}
