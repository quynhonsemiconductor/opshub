import type { vendorAssessments, vendorCriticalityLevels, vendors } from '../../../../../db/schema';

export type Vendor = typeof vendors.$inferSelect;
export type VendorAssessment = typeof vendorAssessments.$inferSelect;
export type VendorCriticalityLevel = typeof vendorCriticalityLevels.$inferSelect;
export type VendorCriticality = Vendor['criticality'];
export type VendorStatus = Vendor['status'];
export type VendorAssessmentOutcome = VendorAssessment['outcome'];

export interface RegisterVendorInput {
  reference: string;
  name: string;
  legalName?: string | null;
  services: string;
  criticality: VendorCriticality;
  ownerId: string;
  dataProcessor?: boolean;
  dataProcessingAgreementId?: string | null;
  dataLocation?: string | null;
  contractStartsOn?: string | null;
  contractEndsOn?: string | null;
  noticePeriodDays?: number | null;
}

/**
 * What may be corrected without a status change.
 *
 * `status`, `terminatedAt`, `terminationReason` and `reviewDueOn` are all absent. The first three
 * belong to the lifecycle methods, which check preconditions a patch would bypass; `reviewDueOn` is
 * computed from the criticality tier when an assessment is recorded, and accepting it here would let
 * a caller push their own next review date out indefinitely.
 *
 * Which is also why `criticality` being HERE re-dates the review: the tier carries the cadence, so a
 * correction to it is a correction to the due date, computed the same way from the same last
 * assessment. There is no hand-set due date for that to overwrite — this type is the reason.
 */
export type UpdateVendorInput = Partial<{
  name: string;
  legalName: string | null;
  services: string;
  criticality: VendorCriticality;
  ownerId: string;
  dataProcessor: boolean;
  dataProcessingAgreementId: string | null;
  dataLocation: string | null;
  contractStartsOn: string | null;
  contractEndsOn: string | null;
  noticePeriodDays: number | null;
}>;

export interface VendorFilters {
  status?: VendorStatus;
  criticality?: VendorCriticality;
  ownerId?: string;
  /** Data processors only — the Article 30 register of who handles personal data for us. */
  processorsOnly?: boolean;
  /** Due for reassessment on or before this date. Today's date gives the overdue report. */
  reviewDueOnOrBefore?: string;
  /** Terminated suppliers are excluded unless asked for: the register means who we use now. */
  includeTerminated?: boolean;
  search?: string;
}

export interface RecordAssessmentInput {
  outcome: VendorAssessmentOutcome;
  scope: string;
  findings?: string | null;
  conditions?: string | null;
  evidenceDocumentId?: string | null;
  /** When it was assessed. Defaults to now; supplied when writing up after the fact. */
  assessedAt?: string;
}

/** A register row with its tier's rank and cadence, and its latest assessment, in one query. */
export interface VendorRow extends Vendor {
  criticalityRank: number;
  reviewIntervalMonths: number;
  requiresIndependentEvidence: boolean;
  /** Null when nobody has ever assessed them — which is the gap the report looks for. */
  lastAssessedAt: Date | null;
  lastOutcome: VendorAssessmentOutcome | null;
  /** How many register risks are linked. Zero is a real answer, not a missing one. */
  riskCount: number;
}

/**
 * A supplier who has never been assessed, or whose assessment is past its cadence.
 *
 * `dueOn` is the STORED `review_due_on`, not a value this report derives — so the report, the
 * register screen and the `reviewDueOnOrBefore` filter cannot disagree about who is overdue. The
 * column is written in SQL from the last assessment and the tier's interval, by the two paths that
 * can change either input: recording an assessment, and correcting the criticality.
 */
export interface VendorReviewGap {
  id: string;
  reference: string;
  name: string;
  criticality: VendorCriticality;
  criticalityRank: number;
  status: VendorStatus;
  lastAssessedAt: Date | null;
  dueOn: string | null;
  /** Null when never assessed: there is no interval to be overdue by. */
  daysOverdue: number | null;
}

/**
 * Money going to a supplier nobody has assessed.
 *
 * The point of `software_licenses.vendor_id` existing at all. Two shapes of gap are reported
 * together because they are the same problem to whoever has to act on it: a licence with no vendor
 * linked, and a licence whose vendor has never been assessed.
 */
export interface UnassessedSpend {
  licenseId: string;
  licenseName: string;
  /** The free-text vendor on the licence — what to search the register for. */
  vendorText: string;
  /** Null when the licence is not linked to the register at all. */
  vendorId: string | null;
  vendorReference: string | null;
  renewalDate: string | null;
  /** Monthly cost per seat in USD cents, as held on the licence. */
  costPerSeatCents: number | null;
  seatCount: number | null;
}
