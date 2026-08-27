import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { InjectDrizzle, type DbExecutor, type DrizzleDB, searchAcross } from '@platform';
import { newId } from '@shared-kernel';
import {
  documents,
  risks,
  softwareLicenses,
  vendorAssessments,
  vendorCriticalityLevels,
  vendorRisks,
  vendors,
} from '../../../../../../db/schema';
import type { IVendorRepository } from '../../domain/ports/vendor.repository';
import type { Risk } from '../../domain/risk.types';
import type {
  RecordAssessmentInput,
  RegisterVendorInput,
  UnassessedSpend,
  UpdateVendorInput,
  Vendor,
  VendorAssessment,
  VendorCriticalityLevel,
  VendorFilters,
  VendorReviewGap,
  VendorRow,
} from '../../domain/vendor.types';

/**
 * One column of the vendor's LATEST assessment, as a correlated subquery.
 *
 * "Latest" is defined here and only here — `assessed_at DESC, id DESC`, with the id breaking the tie
 * a bulk import creates. The list view, the review-gap report and the go-live precondition all read
 * it through this helper, so they cannot disagree about which assessment counts.
 *
 * A `LEFT JOIN LATERAL` would fetch both columns in one pass, but Drizzle's builder cannot inject a
 * lateral into a composed query without dropping to raw SQL for the whole statement — which would
 * take the WHERE and ORDER BY with it. Two correlated subqueries on an indexed
 * `(vendor_id, assessed_at, id)` is the cheaper trade in everything except row count.
 */
function latestAssessment(column: 'assessed_at' | 'outcome') {
  return sql`(
    SELECT va.${sql.raw(column)} FROM isms.vendor_assessments va
    WHERE va.vendor_id = ${vendors.id}
    ORDER BY va.assessed_at DESC, va.id DESC
    LIMIT 1
  )`;
}

/** How many register risks are linked, as a correlated subquery. */
const RISK_COUNT = sql<number>`(
  SELECT count(*)::int FROM isms.vendor_risks vr WHERE vr.vendor_id = isms.vendors.id
)`;

@Injectable()
export class VendorDrizzleRepository implements IVendorRepository {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  // ── Criticality tiers ────────────────────────────────────────────────────────

  async listLevels(): Promise<VendorCriticalityLevel[]> {
    return (
      this.db
        .select()
        .from(vendorCriticalityLevels)
        // `rank` is UNIQUE, so this already orders totally — `code` is appended because it is the
        // PRIMARY KEY, which makes the total order structural rather than something to go and confirm.
        .orderBy(asc(vendorCriticalityLevels.rank), asc(vendorCriticalityLevels.code))
    );
  }

  // ── Register ─────────────────────────────────────────────────────────────────

  async create(input: RegisterVendorInput, tx?: DbExecutor): Promise<Vendor> {
    const [row] = await (tx ?? this.db)
      .insert(vendors)
      .values({
        id: newId(),
        reference: input.reference,
        name: input.name,
        legalName: input.legalName ?? null,
        services: input.services,
        criticality: input.criticality,
        ownerId: input.ownerId,
        dataProcessor: input.dataProcessor ?? false,
        dataProcessingAgreementId: input.dataProcessingAgreementId ?? null,
        dataLocation: input.dataLocation ?? null,
        contractStartsOn: input.contractStartsOn ?? null,
        contractEndsOn: input.contractEndsOn ?? null,
        noticePeriodDays: input.noticePeriodDays ?? null,
      })
      .returning();
    return row;
  }

  async findById(id: string, tx?: DbExecutor): Promise<Vendor | null> {
    const [row] = await (tx ?? this.db).select().from(vendors).where(eq(vendors.id, id)).limit(1);
    return row ?? null;
  }

  async findByReference(reference: string): Promise<Vendor | null> {
    const [row] = await this.db
      .select()
      .from(vendors)
      .where(eq(vendors.reference, reference))
      .limit(1);
    return row ?? null;
  }

  /**
   * Whether a controlled document exists — see the port for why this lives here.
   *
   * `select 1 ... limit 1` on the primary key: the caller wants a boolean, and projecting the row
   * would invite somebody to start reading fields off a document through the vendor repository.
   */
  async documentExists(id: string, tx?: DbExecutor): Promise<boolean> {
    const [row] = await (tx ?? this.db)
      .select({ one: sql<number>`1` })
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1);
    return row !== undefined;
  }

  async list(
    filters: VendorFilters,
    limit: number,
    offset: number,
  ): Promise<{ rows: VendorRow[]; total: number }> {
    const where = and(
      filters.status ? eq(vendors.status, filters.status) : undefined,
      filters.criticality ? eq(vendors.criticality, filters.criticality) : undefined,
      filters.ownerId ? eq(vendors.ownerId, filters.ownerId) : undefined,
      filters.processorsOnly ? eq(vendors.dataProcessor, true) : undefined,
      filters.reviewDueOnOrBefore
        ? lte(vendors.reviewDueOn, filters.reviewDueOnOrBefore)
        : undefined,
      // The register means who we use NOW, so terminated rows are out unless asked for.
      filters.includeTerminated ? undefined : ne(vendors.status, 'terminated'),
      searchAcross(filters.search, vendors.name, vendors.legalName, vendors.reference),
    );

    const rows = await this.db
      .select({
        ...vendorColumns(),
        criticalityRank: vendorCriticalityLevels.rank,
        reviewIntervalMonths: vendorCriticalityLevels.reviewIntervalMonths,
        requiresIndependentEvidence: vendorCriticalityLevels.requiresIndependentEvidence,
        lastAssessedAt: sql<Date | null>`${latestAssessment('assessed_at')}`,
        lastOutcome: sql<VendorAssessment['outcome'] | null>`${latestAssessment('outcome')}`,
        riskCount: RISK_COUNT,
      })
      .from(vendors)
      // INNER, and it cannot drop a row: `criticality` is an FK to this table and NOT NULL.
      .innerJoin(vendorCriticalityLevels, eq(vendorCriticalityLevels.code, vendors.criticality))
      .where(where)
      // Most critical first, then by name: the register is read top-down when deciding what to look
      // at. Ranked by the LEVELS TABLE, never by the enum's declaration order. `id` last, because
      // neither rank nor name is unique.
      .orderBy(desc(vendorCriticalityLevels.rank), asc(vendors.name), asc(vendors.id))
      .limit(limit)
      .offset(offset);

    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(vendors)
      .where(where);

    return { rows, total: count };
  }

  async update(id: string, input: UpdateVendorInput, tx?: DbExecutor): Promise<Vendor | null> {
    const [row] = await (tx ?? this.db)
      .update(vendors)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(vendors.id, id))
      .returning();
    return row ?? null;
  }

  async transition(
    id: string,
    from: Vendor['status'],
    to: Vendor['status'],
    extra: Partial<Pick<Vendor, 'terminatedAt' | 'terminationReason'>>,
    tx?: DbExecutor,
  ): Promise<Vendor | null> {
    const [row] = await (tx ?? this.db)
      .update(vendors)
      .set({ status: to, ...extra, updatedAt: new Date() })
      // The FROM state is in the WHERE clause, so two people approving the same supplier is
      // Postgres's decision rather than a race between two reads.
      .where(and(eq(vendors.id, id), eq(vendors.status, from)))
      .returning();
    return row ?? null;
  }

  async setReviewDueOn(
    id: string,
    assessedAt: Date,
    intervalMonths: number,
    tx?: DbExecutor,
  ): Promise<Vendor | null> {
    const [row] = await (tx ?? this.db)
      .update(vendors)
      .set({
        // Computed by Postgres, not by JavaScript. `setUTCMonth` and `+ interval '1 month'` disagree
        // at month ends (31 January plus one month), and this is the value every reader compares
        // against — so there has to be exactly one arithmetic behind it.
        reviewDueOn: sql`((${assessedAt.toISOString()}::timestamptz
          + (${intervalMonths} * interval '1 month'))::date)`,
        updatedAt: new Date(),
      })
      .where(eq(vendors.id, id))
      .returning();
    return row ?? null;
  }

  // ── Assessments ──────────────────────────────────────────────────────────────

  async appendAssessment(
    vendorId: string,
    input: Omit<RecordAssessmentInput, 'assessedAt'> & { assessedBy: string; assessedAt: Date },
    tx?: DbExecutor,
  ): Promise<VendorAssessment> {
    const [row] = await (tx ?? this.db)
      .insert(vendorAssessments)
      .values({
        id: newId(),
        vendorId,
        assessedAt: input.assessedAt,
        assessedBy: input.assessedBy,
        outcome: input.outcome,
        scope: input.scope,
        findings: input.findings ?? null,
        conditions: input.conditions ?? null,
        evidenceDocumentId: input.evidenceDocumentId ?? null,
      })
      .returning();
    return row;
  }

  async listAssessments(vendorId: string): Promise<VendorAssessment[]> {
    return (
      this.db
        .select()
        .from(vendorAssessments)
        .where(eq(vendorAssessments.vendorId, vendorId))
        // Latest first — the current standing is what a reader wants, the history is context. `id`
        // last, because a bulk import gives several assessments one timestamp.
        .orderBy(desc(vendorAssessments.assessedAt), desc(vendorAssessments.id))
    );
  }

  async latestAssessment(vendorId: string, tx?: DbExecutor): Promise<VendorAssessment | null> {
    const [row] = await (tx ?? this.db)
      .select()
      .from(vendorAssessments)
      .where(eq(vendorAssessments.vendorId, vendorId))
      .orderBy(desc(vendorAssessments.assessedAt), desc(vendorAssessments.id))
      .limit(1);
    return row ?? null;
  }

  // ── Vendor ↔ risk ────────────────────────────────────────────────────────────

  async linkRisk(
    vendorId: string,
    riskId: string,
    linkedBy: string,
    tx?: DbExecutor,
  ): Promise<void> {
    await (tx ?? this.db)
      .insert(vendorRisks)
      .values({ vendorId, riskId, linkedBy })
      // Linking twice is the same link. Idempotent rather than a 409: the caller's intent is
      // already true.
      .onConflictDoNothing();
  }

  async unlinkRisk(vendorId: string, riskId: string, tx?: DbExecutor): Promise<boolean> {
    const removed = await (tx ?? this.db)
      .delete(vendorRisks)
      .where(and(eq(vendorRisks.vendorId, vendorId), eq(vendorRisks.riskId, riskId)))
      .returning();
    return removed.length > 0;
  }

  async listRisksFor(vendorId: string): Promise<Risk[]> {
    return (
      this.db
        .select({ ...riskColumns() })
        .from(vendorRisks)
        .innerJoin(risks, eq(risks.id, vendorRisks.riskId))
        .where(eq(vendorRisks.vendorId, vendorId))
        // Worst first, `id` last: the score is not unique.
        .orderBy(desc(risks.inherentScore), asc(risks.id))
    );
  }

  // ── Reports ──────────────────────────────────────────────────────────────────

  async reviewGaps(limit: number): Promise<VendorReviewGap[]> {
    const lastAt = latestAssessment('assessed_at');

    return (
      this.db
        .select({
          id: vendors.id,
          reference: vendors.reference,
          name: vendors.name,
          criticality: vendors.criticality,
          criticalityRank: vendorCriticalityLevels.rank,
          status: vendors.status,
          lastAssessedAt: sql<Date | null>`${lastAt}`,
          dueOn: vendors.reviewDueOn,
          // Null when never assessed: there is no interval to be overdue by, and reporting 0 would
          // read as "due today" for the supplier nobody has ever looked at.
          daysOverdue: sql<number | null>`
          CASE WHEN ${vendors.reviewDueOn} IS NULL THEN NULL
               ELSE (current_date - ${vendors.reviewDueOn})::int END
        `,
        })
        .from(vendors)
        .innerJoin(vendorCriticalityLevels, eq(vendorCriticalityLevels.code, vendors.criticality))
        .where(
          and(
            // A terminated supplier needs no reassessment, and a prospective one is not yet a gap in
            // anything — it is the ones we RELY on that have to stay current.
            inArray(vendors.status, ['active', 'suspended']),
            // Never assessed, OR past the stored due date. Both are the same finding to whoever acts
            // on it: nobody currently knows whether this supplier is safe to depend on.
            //
            // The null branch is not reachable through the API today — going live requires an
            // assessment, which sets `review_due_on` — so it guards rows that arrive another way: a
            // seed, an import, or a future bulk registration. Kept because the report's job is to find
            // suppliers nobody has checked, and silently omitting the worst case of that would be the
            // failure mode hardest to notice.
            or(isNull(vendors.reviewDueOn), lte(vendors.reviewDueOn, sql`current_date`)),
          ),
        )
        // Never assessed first — `NULLS FIRST` is stated rather than relied on, because Postgres puts
        // nulls LAST by default on ASC. Then worst tier, then `id` to make the order total.
        .orderBy(
          sql`${vendors.reviewDueOn} ASC NULLS FIRST`,
          desc(vendorCriticalityLevels.rank),
          asc(vendors.id),
        )
        .limit(limit)
    );
  }

  async criticalWithoutRisk(limit: number): Promise<Vendor[]> {
    return this.db
      .select({ ...vendorColumns() })
      .from(vendors)
      .innerJoin(vendorCriticalityLevels, eq(vendorCriticalityLevels.code, vendors.criticality))
      .where(
        and(
          eq(vendors.status, 'active'),
          // The top two tiers, by RANK rather than by naming the labels: adding a tier above
          // `critical` should widen this report without anybody remembering to edit it.
          gte(
            vendorCriticalityLevels.rank,
            sql`(SELECT max(rank) - 1 FROM isms.vendor_criticality_levels)`,
          ),
          sql`NOT EXISTS (SELECT 1 FROM ${vendorRisks} WHERE ${vendorRisks.vendorId} = ${vendors.id})`,
        ),
      )
      .orderBy(desc(vendorCriticalityLevels.rank), asc(vendors.name), asc(vendors.id))
      .limit(limit);
  }

  async unassessedSpend(limit: number): Promise<UnassessedSpend[]> {
    return (
      this.db
        .select({
          licenseId: softwareLicenses.id,
          licenseName: softwareLicenses.name,
          vendorText: softwareLicenses.vendor,
          vendorId: softwareLicenses.vendorId,
          vendorReference: vendors.reference,
          renewalDate: softwareLicenses.renewalDate,
          costPerSeatCents: softwareLicenses.costPerSeatCents,
          seatCount: softwareLicenses.seatCount,
        })
        .from(softwareLicenses)
        // LEFT, because an unlinked licence is half the point of the report.
        .leftJoin(vendors, eq(vendors.id, softwareLicenses.vendorId))
        .where(
          and(
            // A cancelled licence is not spend.
            eq(softwareLicenses.status, 'active'),
            or(
              // Not linked to the register at all.
              isNull(softwareLicenses.vendorId),
              // Linked, but nobody has ever assessed them.
              sql`NOT EXISTS (
              SELECT 1 FROM ${vendorAssessments}
              WHERE ${vendorAssessments.vendorId} = ${softwareLicenses.vendorId}
            )`,
            ),
          ),
        )
        // Soonest renewal first — the deadline by which the gap has to be closed or the money stops.
        // Nulls last so undated licences do not crowd out the ones with a date.
        .orderBy(sql`${softwareLicenses.renewalDate} ASC NULLS LAST`, asc(softwareLicenses.id))
        .limit(limit)
    );
  }
}

/**
 * The register's own columns, named explicitly.
 *
 * `list` projects extra columns alongside them, and Drizzle's `select()` with no argument would
 * return the joined shape nested under table keys instead.
 */
function vendorColumns() {
  return {
    id: vendors.id,
    reference: vendors.reference,
    name: vendors.name,
    legalName: vendors.legalName,
    services: vendors.services,
    criticality: vendors.criticality,
    status: vendors.status,
    ownerId: vendors.ownerId,
    dataProcessor: vendors.dataProcessor,
    dataProcessingAgreementId: vendors.dataProcessingAgreementId,
    dataLocation: vendors.dataLocation,
    contractStartsOn: vendors.contractStartsOn,
    contractEndsOn: vendors.contractEndsOn,
    noticePeriodDays: vendors.noticePeriodDays,
    reviewDueOn: vendors.reviewDueOn,
    terminatedAt: vendors.terminatedAt,
    terminationReason: vendors.terminationReason,
    createdAt: vendors.createdAt,
    updatedAt: vendors.updatedAt,
  };
}

function riskColumns() {
  return {
    id: risks.id,
    reference: risks.reference,
    title: risks.title,
    description: risks.description,
    category: risks.category,
    assetId: risks.assetId,
    ownerId: risks.ownerId,
    inherentLikelihood: risks.inherentLikelihood,
    inherentImpact: risks.inherentImpact,
    inherentScore: risks.inherentScore,
    treatmentDecision: risks.treatmentDecision,
    residualLikelihood: risks.residualLikelihood,
    residualImpact: risks.residualImpact,
    residualScore: risks.residualScore,
    status: risks.status,
    reviewDueOn: risks.reviewDueOn,
    acceptedBy: risks.acceptedBy,
    acceptedAt: risks.acceptedAt,
    acceptanceJustification: risks.acceptanceJustification,
    acceptedViaRequestId: risks.acceptedViaRequestId,
    closedAt: risks.closedAt,
    closureNote: risks.closureNote,
    createdAt: risks.createdAt,
    updatedAt: risks.updatedAt,
  };
}
