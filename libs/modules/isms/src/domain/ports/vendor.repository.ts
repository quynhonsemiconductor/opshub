import type { DbExecutor } from '@platform';
import type { Risk } from '../risk.types';
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
} from '../vendor.types';

export const VENDOR_REPOSITORY = Symbol('VENDOR_REPOSITORY');

export interface IVendorRepository {
  // ── Criticality tiers ──────────────────────────────────────────────────────
  /**
   * The tiers with their ranks and review intervals.
   *
   * THE ONLY SOURCE OF BOTH. Nothing hard-codes the ordering, and nothing hard-codes the cadence:
   * the next review date is computed from the interval read from here, so a policy change is an
   * UPDATE to one table rather than a hunt through the service.
   */
  listLevels(): Promise<VendorCriticalityLevel[]>;

  // ── Register ───────────────────────────────────────────────────────────────
  create(input: RegisterVendorInput, tx?: DbExecutor): Promise<Vendor>;
  findById(id: string, tx?: DbExecutor): Promise<Vendor | null>;
  findByReference(reference: string): Promise<Vendor | null>;
  /**
   * Whether a controlled document with this id exists — the `documents` schema, read from here.
   *
   * `vendors.data_processing_agreement_id` carries NO foreign key, deliberately and like every other
   * cross-schema reference in this codebase, so nothing but a lookup can tell a real agreement from
   * a mistyped uuid. Answered in this repository rather than by injecting `DocumentsService` into the
   * register: the vendor queries already cross a schema for the spend report, and a module edge from
   * ISMS to documents would exist to answer a single boolean.
   *
   * A RETIRED DOCUMENT COUNTS. Retirement in `documents` is soft — the row stays readable so a
   * superseded control is still explainable years later — and an agreement that was in force when the
   * supplier was assessed is exactly the evidence an auditor asks for.
   */
  documentExists(id: string, tx?: DbExecutor): Promise<boolean>;
  list(
    filters: VendorFilters,
    limit: number,
    offset: number,
  ): Promise<{ rows: VendorRow[]; total: number }>;
  update(id: string, input: UpdateVendorInput, tx?: DbExecutor): Promise<Vendor | null>;

  /**
   * Move the vendor's status, guarding the FROM state in the WHERE clause.
   *
   * Returns null when the row was not in `from` — which is what makes the transition atomic rather
   * than a read-then-write two people can both pass while approving the same supplier.
   */
  transition(
    id: string,
    from: Vendor['status'],
    to: Vendor['status'],
    extra: Partial<Pick<Vendor, 'terminatedAt' | 'terminationReason'>>,
    tx?: DbExecutor,
  ): Promise<Vendor | null>;

  /**
   * Set the next review date to `assessedAt + intervalMonths`, computed IN SQL.
   *
   * The caller passes the inputs, never the answer. Computing it in Postgres rather than in
   * TypeScript is what keeps ONE definition of the due date: a JS `setUTCMonth` and
   * `+ interval '1 month'` disagree at month ends, and the version the screen shows would then
   * differ from the version any report derived.
   */
  setReviewDueOn(
    id: string,
    assessedAt: Date,
    intervalMonths: number,
    tx?: DbExecutor,
  ): Promise<Vendor | null>;

  // ── Assessments ────────────────────────────────────────────────────────────
  /**
   * Append one assessment. There is deliberately no update and no delete — and since migration
   * 0023 the application role holds no UPDATE or DELETE privilege on the table either.
   *
   * `assessedAt` is OMITTED from the input type and re-added as a `Date`: the DTO carries it as an
   * ISO string, and intersecting the two gives `string & Date`, which nothing satisfies.
   */
  appendAssessment(
    vendorId: string,
    input: Omit<RecordAssessmentInput, 'assessedAt'> & { assessedBy: string; assessedAt: Date },
    tx?: DbExecutor,
  ): Promise<VendorAssessment>;
  listAssessments(vendorId: string): Promise<VendorAssessment[]>;
  /** The most recent assessment, which is the one that decides whether a vendor may go live. */
  latestAssessment(vendorId: string, tx?: DbExecutor): Promise<VendorAssessment | null>;

  // ── Vendor ↔ risk ──────────────────────────────────────────────────────────
  linkRisk(vendorId: string, riskId: string, linkedBy: string, tx?: DbExecutor): Promise<void>;
  unlinkRisk(vendorId: string, riskId: string, tx?: DbExecutor): Promise<boolean>;
  listRisksFor(vendorId: string): Promise<Risk[]>;

  // ── Reports ────────────────────────────────────────────────────────────────
  /**
   * Suppliers never assessed, or past the cadence their tier demands.
   *
   * Reads the STORED `review_due_on` rather than re-deriving it. The date is computed once, in SQL,
   * when an assessment is recorded — so this report, the list filter and the screen all mean the
   * same thing by "overdue". Re-deriving here would make the report disagree with the column the
   * user is looking at whenever the two arithmetics differ, which they do at month ends.
   *
   * The trade, stated: changing a TIER'S INTERVAL — the reference-data row, which applies to every
   * supplier at that tier — does not re-date suppliers already assessed. It applies from their next
   * assessment, and a policy change that must apply immediately is a migration.
   *
   * Correcting ONE SUPPLIER'S TIER is the other case and is not that trade: `VendorService.update`
   * recomputes `review_due_on` from the last assessment and the new tier, so this report moves with
   * the correction instead of waiting for an assessment that the new cadence says is already overdue.
   */
  reviewGaps(limit: number): Promise<VendorReviewGap[]>;
  /**
   * Active suppliers at the top tiers with no register risk linked.
   *
   * The same anti-join as "untreated risks" and "incidents with no risk": depending on a critical
   * supplier while recording no risk about them is a gap in the assessment, not an absence of risk.
   */
  criticalWithoutRisk(limit: number): Promise<Vendor[]>;
  /** Licences whose vendor is unlinked or unassessed — money going somewhere nobody checked. */
  unassessedSpend(limit: number): Promise<UnassessedSpend[]>;
}
