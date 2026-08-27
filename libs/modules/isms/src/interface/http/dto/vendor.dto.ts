import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { queryBoolean } from '@platform';
import { PaginationQuerySchema } from '@shared-kernel';
import {
  vendorAssessmentOutcomeEnum,
  vendorCriticalityEnum,
  vendorStatusEnum,
} from '@db/schema/enums';

const criticality = z.enum(vendorCriticalityEnum.enumValues);
const status = z.enum(vendorStatusEnum.enumValues);
const outcome = z.enum(vendorAssessmentOutcomeEnum.enumValues);

/**
 * `YYYY-MM-DD`. The whole codebase compares dates as strings — see `assertDateOrder`.
 *
 * `z.string().date()` rather than a shape regex: it is the idiom the other 27 date fields use, and it
 * rejects `2026-02-31`, which a regex happily accepts.
 */
const isoDate = z.string().date();

/** 10 characters minimum, matching the substance CHECKs and the service's refusals. */
const substantial = z.string().min(10).max(5000);

export const RegisterVendorSchema = z.object({
  /** Quoted in the register, in assessments and in audit findings. */
  reference: z
    .string()
    .min(3)
    .max(40)
    .regex(/^[A-Z][A-Z0-9.-]*$/, 'Use uppercase letters, digits, dots and hyphens, e.g. VEN-014'),
  name: z.string().min(2).max(200),
  /** The name on the contract, when it differs — which it usually does. */
  legalName: z.string().max(200).nullable().optional(),
  /** What they do for us. The sentence that makes the criticality tier defensible. */
  services: substantial,
  criticality,
  ownerId: z.string().uuid(),
  dataProcessor: z.boolean().optional(),
  /**
   * The DPA as a controlled document. Required before an active processor — see the service.
   *
   * `uuid()` only proves the SHAPE. That it names a real document is checked by the service, because
   * there is no foreign key across schemas and a well-formed wrong uuid is the failure that looks
   * like a complete Article 28 record.
   */
  dataProcessingAgreementId: z.string().uuid().nullable().optional(),
  dataLocation: z.string().max(200).nullable().optional(),
  contractStartsOn: isoDate.nullable().optional(),
  contractEndsOn: isoDate.nullable().optional(),
  noticePeriodDays: z.number().int().min(0).nullable().optional(),
});
export class RegisterVendorDto extends createZodDto(RegisterVendorSchema) {}

/**
 * `status`, `reviewDueOn` and the termination fields are all absent DELIBERATELY.
 *
 * The status belongs to the lifecycle routes, which check preconditions a patch would bypass —
 * approving a supplier through a PATCH would skip the assessment requirement entirely. `reviewDueOn`
 * is computed from the criticality tier when an assessment is recorded; accepting it here would let a
 * caller push their own next review out indefinitely, which is the one thing the cadence exists to
 * prevent.
 *
 * `criticality` IS accepted, and moves the due date with it — the tier is the cadence, so correcting
 * the tier without recomputing the date would leave a supplier reported on the old schedule.
 */
export const UpdateVendorSchema = RegisterVendorSchema.omit({ reference: true })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Supply at least one field to update');
export class UpdateVendorDto extends createZodDto(UpdateVendorSchema) {}

export const RecordAssessmentSchema = z.object({
  outcome,
  /** What was actually examined — the questionnaire, the SOC 2 report, the site visit. */
  scope: substantial,
  /** Required by the service and by `ck_vendor_assessment_failure_findings` when the outcome fails. */
  findings: z.string().max(5000).nullable().optional(),
  /** Required for `pass_with_conditions` — an unwritten condition is not one. */
  conditions: z.string().max(5000).nullable().optional(),
  evidenceDocumentId: z.string().uuid().nullable().optional(),
  /** When it was assessed. Defaults to now; supplied when writing up after the fact. */
  assessedAt: z.string().datetime().optional(),
});
export class RecordAssessmentDto extends createZodDto(RecordAssessmentSchema) {}

export const VendorReasonSchema = z.object({
  /** Why. Required by `ck_vendor_termination_reason` for a termination, and recorded for a suspension. */
  reason: substantial,
});
export class VendorReasonDto extends createZodDto(VendorReasonSchema) {}

export const ListVendorsQuerySchema = z
  .object({
    status: status.optional(),
    criticality: criticality.optional(),
    ownerId: z.string().uuid().optional(),
    /** Data processors only — the Article 30 question. */
    processorsOnly: queryBoolean().optional(),
    reviewDueOnOrBefore: isoDate.optional(),
    includeTerminated: queryBoolean().optional(),
    search: z.string().max(200).optional(),
  })
  .merge(PaginationQuerySchema);
export class ListVendorsQueryDto extends createZodDto(ListVendorsQuerySchema) {}

// ── Responses ─────────────────────────────────────────────────────────────────

export class VendorCriticalityLevelResponseDto {
  code!: string;
  /** Higher matters more. THE ordering — the enum's declaration order is not authoritative. */
  rank!: number;
  label!: string;
  description!: string;
  /** How often a supplier at this tier must be reassessed. Drives `reviewDueOn`. */
  reviewIntervalMonths!: number;
  requiresIndependentEvidence!: boolean;
}

export class VendorResponseDto {
  id!: string;
  reference!: string;
  name!: string;
  legalName!: string | null;
  services!: string;
  criticality!: string;
  status!: string;
  ownerId!: string;
  /**
   * The relationship owner's display name, resolved server-side on the READ paths.
   *
   * Nullable although `ownerId` is not, for two reasons. A supplier record outlives the person who
   * owned the relationship — the lookup is a left one, never a join, because a terminated vendor's
   * row, its assessments and its risk links are the audit evidence and must not disappear with an
   * employee. And the write paths do not resolve it: their responses are refetched by the SPA, so it
   * would be a query nobody reads added to nine mutations.
   *
   * Sent rather than resolved by the SPA because `GET /v1/employees` needs `employee.read`, which a
   * `vendor.read` holder is not required to have.
   */
  ownerName!: string | null;
  dataProcessor!: boolean;
  dataProcessingAgreementId!: string | null;
  dataLocation!: string | null;
  contractStartsOn!: string | null;
  contractEndsOn!: string | null;
  noticePeriodDays!: number | null;
  /** Computed from the criticality tier when an assessment is recorded. Never settable. */
  reviewDueOn!: string | null;
  terminatedAt!: string | null;
  terminationReason!: string | null;
  createdAt!: string;
}

export class VendorRowResponseDto extends VendorResponseDto {
  /** Resolved from `isms.vendor_criticality_levels` in the same query as the row. */
  criticalityRank!: number;
  reviewIntervalMonths!: number;
  requiresIndependentEvidence!: boolean;
  /** Null when nobody has ever assessed them — the gap the review report looks for. */
  lastAssessedAt!: string | null;
  lastOutcome!: string | null;
  riskCount!: number;
}

export class VendorAssessmentResponseDto {
  id!: string;
  vendorId!: string;
  assessedAt!: string;
  assessedBy!: string;
  outcome!: string;
  scope!: string;
  findings!: string | null;
  conditions!: string | null;
  evidenceDocumentId!: string | null;
}

export class VendorReviewGapResponseDto {
  id!: string;
  reference!: string;
  name!: string;
  criticality!: string;
  criticalityRank!: number;
  status!: string;
  lastAssessedAt!: string | null;
  dueOn!: string | null;
  /** Null when never assessed: there is no interval to be overdue by. */
  daysOverdue!: number | null;
}

export class UnassessedSpendResponseDto {
  licenseId!: string;
  licenseName!: string;
  /** The free-text vendor on the licence — what to search the register for. */
  vendorText!: string;
  /** Null when the licence is not linked to the register at all. */
  vendorId!: string | null;
  vendorReference!: string | null;
  renewalDate!: string | null;
  costPerSeatCents!: number | null;
  seatCount!: number | null;
}
