import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { queryBoolean } from '@platform';
import { PaginationQuerySchema } from '@shared-kernel';
import {
  controlImplementationStatusEnum,
  controlSourceEnum,
  controlThemeEnum,
} from '@db/schema/enums';

const theme = z.enum(controlThemeEnum.enumValues);
const source = z.enum(controlSourceEnum.enumValues);
const status = z.enum(controlImplementationStatusEnum.enumValues);

export const CreateControlSchema = z.object({
  /** The standard's own reference, e.g. `A.5.1`. Dots allowed — Annex A uses them. */
  reference: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[A-Z][A-Z0-9.-]*$/, 'Use uppercase letters, digits, dots and hyphens, e.g. A.5.1'),
  title: z.string().min(3).max(300),
  description: z.string().max(5000).nullable().optional(),
  theme,
  source: source.optional(),
});
export class CreateControlDto extends createZodDto(CreateControlSchema) {}

export const UpdateControlSchema = CreateControlSchema.omit({ reference: true, source: true })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Supply at least one field to update');
export class UpdateControlDto extends createZodDto(UpdateControlSchema) {}

export const ListControlsQuerySchema = z
  .object({
    theme: theme.optional(),
    source: source.optional(),
    includeRetired: queryBoolean().optional(),
  })
  .merge(PaginationQuerySchema);
export class ListControlsQueryDto extends createZodDto(ListControlsQuerySchema) {}

/**
 * The SoA decision, supplied WHOLE.
 *
 * Not a patch, and not `.partial()`: applicability, justification and status are one statement, so a
 * request that changes only one of them cannot express what the other two now mean. The consistency
 * rule between `applicable` and `status` is enforced in the service with the specific
 * `SOA_INCONSISTENT` code rather than here, so the message can say which combination was wrong.
 */
export const SetSoaEntrySchema = z.object({
  applicable: z.boolean(),
  /** 10 characters minimum, matching `ck_soa_justification_substance`. */
  justification: z.string().min(10).max(4000),
  status,
  implementationNote: z.string().max(4000).nullable().optional(),
  evidenceDocumentId: z.string().uuid().nullable().optional(),
  ownerId: z.string().uuid().nullable().optional(),
  reviewDueOn: z.string().date().nullable().optional(),
});
export class SetSoaEntryDto extends createZodDto(SetSoaEntrySchema) {}

export const MarkReviewedSchema = z.object({
  /** The NEXT review date. Omit to record the review without scheduling another. */
  reviewDueOn: z.string().date().nullable().optional(),
});
export class MarkReviewedDto extends createZodDto(MarkReviewedSchema) {}

export const ListSoaQuerySchema = z
  .object({
    applicable: queryBoolean().optional(),
    status: status.optional(),
    ownerId: z.string().uuid().optional(),
    theme: theme.optional(),
    reviewDueOnOrBefore: z.string().date().optional(),
  })
  .merge(PaginationQuerySchema);
export class ListSoaQueryDto extends createZodDto(ListSoaQuerySchema) {}

// ── Responses ─────────────────────────────────────────────────────────────────

export class ControlResponseDto {
  id!: string;
  reference!: string;
  title!: string;
  description!: string | null;
  theme!: string;
  source!: string;
  retiredAt!: string | null;
  createdAt!: string;
}

export class LinkedControlResponseDto extends ControlResponseDto {
  /** The SoA status, or null when no decision has been recorded for this control yet. */
  status!: string | null;
}

export class SoaEntryResponseDto {
  id!: string;
  controlId!: string;
  applicable!: boolean;
  justification!: string;
  status!: string;
  implementationNote!: string | null;
  evidenceDocumentId!: string | null;
  ownerId!: string | null;
  /**
   * The owner's display name, resolved server-side on the READ paths.
   *
   * Nullable for THREE reasons here, and the screen has to keep them apart. `ownerId` is itself
   * nullable — a statement may be written before anybody is made accountable, and the SoA column says
   * "Unassigned" for that. An entry also outlives the person who owned the control, so the lookup is a
   * left one and never a join: last year's statement is the audit evidence and losing it with an
   * employee row would be far worse than showing no name. And the write paths do not resolve it at
   * all, because the SPA refetches after a `PUT` or a review.
   *
   * Sent rather than resolved by the SPA because `GET /v1/employees` needs `employee.read`, which a
   * `control.read` holder is not required to have, and this is a list column — one name per row would
   * be one request per row.
   */
  ownerName!: string | null;
  lastReviewedAt!: string | null;
  reviewDueOn!: string | null;
}

export class SoaRowResponseDto extends SoaEntryResponseDto {
  controlReference!: string;
  controlTitle!: string;
  controlTheme!: string;
}

export class SoaCoverageResponseDto {
  totalControls!: number;
  /** Controls with NO entry — the state only an absent row can express. */
  undecided!: number;
  applicable!: number;
  excluded!: number;
  implemented!: number;
  partiallyImplemented!: number;
  notImplemented!: number;
}

export class UntreatedRiskResponseDto {
  riskId!: string;
  reference!: string;
  title!: string;
  status!: string;
  inherentScore!: number | null;
  residualScore!: number | null;
}

export class LinkedRiskResponseDto {
  id!: string;
  reference!: string;
  title!: string;
}
