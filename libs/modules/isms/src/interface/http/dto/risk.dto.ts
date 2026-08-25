import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PaginationQuerySchema } from '@shared-kernel';
import { RATING_MAX, RATING_MIN } from '../../../domain/rating';
import {
  riskStatusEnum,
  riskTreatmentDecisionEnum,
  riskTreatmentStatusEnum,
} from '@db/schema/enums';

const riskStatus = z.enum(riskStatusEnum.enumValues);
const decision = z.enum(riskTreatmentDecisionEnum.enumValues);
const treatmentStatus = z.enum(riskTreatmentStatusEnum.enumValues);

/**
 * A 5x5 matrix, matching `ck_risk_inherent_range`.
 *
 * The bounds come from `domain/rating.ts`, which is the single source shared with the information
 * asset register: a 7 in either column would silently change what every threshold in the register
 * means, including `ACCEPTANCE_APPROVAL_THRESHOLD`.
 */
const factor = z.number().int().min(RATING_MIN).max(RATING_MAX);

export const ScoreSchema = z.object({ likelihood: factor, impact: factor });

export const IdentifyRiskSchema = z.object({
  /** Quoted in treatment plans, the SoA and audit findings, so the same uppercase shape as elsewhere. */
  reference: z
    .string()
    .min(3)
    .max(40)
    .regex(/^[A-Z][A-Z0-9-]*$/, 'Use uppercase letters, digits and hyphens, e.g. RSK-2026-014'),
  title: z.string().min(3).max(200),
  description: z.string().min(3).max(5000),
  category: z.string().min(2).max(64),
  assetId: z.string().uuid().nullable().optional(),
  /** The accountable employee. Required — an unowned risk is a note, not a register entry. */
  ownerId: z.string().uuid(),
  inherent: ScoreSchema,
  reviewDueOn: z.string().date().nullable().optional(),
});
export class IdentifyRiskDto extends createZodDto(IdentifyRiskSchema) {}

export const UpdateRiskSchema = IdentifyRiskSchema.omit({ reference: true })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Supply at least one field to update');
export class UpdateRiskDto extends createZodDto(UpdateRiskSchema) {}

export const AssessRiskSchema = z.object({
  decision,
  residual: ScoreSchema,
  reviewDueOn: z.string().date().nullable().optional(),
});
export class AssessRiskDto extends createZodDto(AssessRiskSchema) {}

export const MarkTreatedSchema = z.object({
  /** Optional: treatment often changes the residual, but not always (a transfer may not). */
  residual: ScoreSchema.optional(),
  reviewDueOn: z.string().date().nullable().optional(),
});
export class MarkTreatedDto extends createZodDto(MarkTreatedSchema) {}

export const AcceptRiskSchema = z.object({
  /**
   * Why carrying this exposure is the right call. Required by `ck_risk_accepted_evidence`, and the
   * one field an ISO 27001 auditor reads on an accepted risk.
   */
  justification: z.string().min(10).max(2000),
  reviewDueOn: z.string().date().nullable().optional(),
});
export class AcceptRiskDto extends createZodDto(AcceptRiskSchema) {}

export const CloseRiskSchema = z.object({
  /** Why it no longer applies. A risk that left the register unexplained looks deleted. */
  note: z.string().min(3).max(300),
});
export class CloseRiskDto extends createZodDto(CloseRiskSchema) {}

export const AddTreatmentSchema = z.object({
  description: z.string().min(3).max(5000),
  /** Who does the work. Separate from the risk owner, who stays accountable for the outcome. */
  ownerId: z.string().uuid(),
  dueOn: z.string().date().nullable().optional(),
});
export class AddTreatmentDto extends createZodDto(AddTreatmentSchema) {}

export const UpdateTreatmentSchema = z
  .object({
    description: z.string().min(3).max(5000).optional(),
    ownerId: z.string().uuid().optional(),
    dueOn: z.string().date().nullable().optional(),
    status: treatmentStatus.optional(),
    /** Defaults to today when the status becomes `done` — see `ck_treatment_done_evidence`. */
    completedOn: z.string().date().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Supply at least one field to update');
export class UpdateTreatmentDto extends createZodDto(UpdateTreatmentSchema) {}

export const ListRisksQuerySchema = z
  .object({
    status: riskStatus.optional(),
    category: z.string().max(64).optional(),
    ownerId: z.string().uuid().optional(),
    assetId: z.string().uuid().optional(),
    /** Open risks due for review on or before this date. */
    reviewDueOnOrBefore: z.string().date().optional(),
    /** Inherent score at or above this — the register's "what actually matters" filter. */
    minInherentScore: z.coerce.number().int().min(1).max(25).optional(),
    /** Free text over the reference, title and category. */
    search: z.string().max(200).optional(),
  })
  .merge(PaginationQuerySchema);
export class ListRisksQueryDto extends createZodDto(ListRisksQuerySchema) {}

// ── Responses ─────────────────────────────────────────────────────────────────

export class RiskResponseDto {
  id!: string;
  reference!: string;
  title!: string;
  description!: string;
  category!: string;
  assetId!: string | null;
  ownerId!: string;
  /**
   * The owner's display name, resolved server-side on the READ paths.
   *
   * Nullable although `ownerId` is not, for two reasons. A risk outlives the person accountable for
   * it — the lookup is a left one, never a join, because losing a register entry when an employee
   * row goes is far worse than showing no name. And the write paths do not resolve it: their
   * responses are refetched by the SPA, so a query nobody reads would be added to eight mutations.
   *
   * Sent rather than resolved by the SPA because `GET /v1/employees` needs `employee.read`, which a
   * `risk.read` holder is not required to have, and one request per row is not a page.
   */
  ownerName!: string | null;
  inherentLikelihood!: number;
  inherentImpact!: number;
  /** `likelihood × impact`, computed by Postgres — never written by the application. */
  inherentScore!: number | null;
  treatmentDecision!: string | null;
  residualLikelihood!: number | null;
  residualImpact!: number | null;
  residualScore!: number | null;
  status!: string;
  reviewDueOn!: string | null;
  acceptedBy!: string | null;
  /**
   * WHO signed the acceptance. Null when nobody has accepted the risk, and also when the acceptor's
   * employee row is gone — the acceptance still stands either way, which is why this is resolved with
   * a left lookup and never a join.
   *
   * Sent because this is the signature an ISO 27001 auditor reads: accepting an exposure rather than
   * treating it is a decision somebody is answerable for, and "accepted by <uuid>" names nobody.
   */
  acceptedByName!: string | null;
  acceptedAt!: string | null;
  acceptanceJustification!: string | null;
  /** The request that authorised the acceptance, when one was required. */
  acceptedViaRequestId!: string | null;
  closedAt!: string | null;
  closureNote!: string | null;
  createdAt!: string;
}

export class RiskTreatmentResponseDto {
  id!: string;
  riskId!: string;
  description!: string;
  ownerId!: string;
  dueOn!: string | null;
  status!: string;
  completedOn!: string | null;
  createdAt!: string;
}

export class AcceptRiskResponseDto {
  risk!: RiskResponseDto;
  /**
   * The acceptance request, when the residual score required sign-off.
   *
   * `null` means the acceptance was recorded directly — below the threshold. When it is set, the
   * risk is returned UNCHANGED: nothing is accepted until somebody approves it.
   */
  requestId!: string | null;
}
