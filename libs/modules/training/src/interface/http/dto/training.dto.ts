import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PaginationQuerySchema } from '@shared-kernel';
import { RESOURCE_RULES, queryBoolean } from '@platform';
import { trainingRecordStatusEnum, trainingRequirementKindEnum } from '@db/schema/enums';

const recordStatus = z.enum(trainingRecordStatusEnum.enumValues);
const requirementKind = z.enum(trainingRequirementKindEnum.enumValues);

/** The certificate surface's own policy, so the DTO cannot disagree with what the service enforces. */
const CERTIFICATE_POLICY = RESOURCE_RULES['training-certificate'];

export const CreateCourseSchema = z.object({
  /** Quoted in competency matrices and audit findings, so the same uppercase shape as elsewhere. */
  code: z
    .string()
    .min(2)
    .max(32)
    .regex(/^[A-Z][A-Z0-9-]*$/, 'Use uppercase letters, digits and hyphens, e.g. ISMS-AWARE-01'),
  title: z.string().min(2).max(200),
  category: z.string().min(2).max(64),
  provider: z.string().max(160).nullable().optional(),
  description: z.string().max(5000).nullable().optional(),
  /** Months. Omit or null for a course that never lapses. */
  validityMonths: z.number().int().min(1).max(600).nullable().optional(),
});
export class CreateCourseDto extends createZodDto(CreateCourseSchema) {}

export const UpdateCourseSchema = CreateCourseSchema.omit({ code: true })
  .partial()
  // An empty PATCH is a no-op the caller almost certainly did not mean, and it would still write an
  // audit entry claiming a change.
  .refine((v) => Object.keys(v).length > 0, 'Supply at least one field to update');
export class UpdateCourseDto extends createZodDto(UpdateCourseSchema) {}

export const ListCoursesQuerySchema = z
  .object({
    category: z.string().max(64).optional(),
    includeRetired: queryBoolean().optional(),
  })
  .merge(PaginationQuerySchema);
export class ListCoursesQueryDto extends createZodDto(ListCoursesQuerySchema) {}

export const AddRequirementSchema = z.object({
  courseId: z.string().uuid(),
  kind: requirementKind.optional(),
  /** Days after taking up the position. Omit for "before starting". */
  graceDays: z.number().int().min(0).max(3650).nullable().optional(),
});
export class AddRequirementDto extends createZodDto(AddRequirementSchema) {}

export const RecordCompletionSchema = z.object({
  employeeId: z.string().uuid(),
  courseId: z.string().uuid(),
  completedOn: z.string().date(),
  result: z.string().max(64).nullable().optional(),
  /**
   * A decimal STRING, not a number: `numeric(5,2)` round-trips exactly through a string, while a
   * JSON number is an IEEE double.
   */
  score: z
    .string()
    .regex(/^\d{1,3}(\.\d{1,2})?$/, 'Use a decimal 0–100 with at most 2 places, e.g. "87.50"')
    .refine((v) => Number(v) >= 0 && Number(v) <= 100, 'Score must be between 0 and 100')
    .nullable()
    .optional(),
  notes: z.string().max(5000).nullable().optional(),
});
export class RecordCompletionDto extends createZodDto(RecordCompletionSchema) {}

export const RevokeRecordSchema = z.object({
  /** Required by `ck_training_revoked_reason`: a revocation nobody can account for is worse. */
  reason: z.string().min(3).max(200),
});
export class RevokeRecordDto extends createZodDto(RevokeRecordSchema) {}

export const ListRecordsQuerySchema = z
  .object({
    employeeId: z.string().uuid().optional(),
    courseId: z.string().uuid().optional(),
    status: recordStatus.optional(),
    /** Live records lapsing on or before this date — the renewal queue. */
    expiringOnOrBefore: z.string().date().optional(),
    /** Drop superseded rows, which is what "their current training" means. */
    currentOnly: queryBoolean().optional(),
  })
  .merge(PaginationQuerySchema);
export class ListRecordsQueryDto extends createZodDto(ListRecordsQuerySchema) {}

export const CompetencyGapQuerySchema = z.object({
  employeeId: z.string().uuid().optional(),
  positionId: z.string().uuid().optional(),
  /** Defaults to today. Explicit so "who lapses by quarter end" is one request. */
  asOf: z.string().date().optional(),
  includeRecommended: queryBoolean().optional(),
});
export class CompetencyGapQueryDto extends createZodDto(CompetencyGapQuerySchema) {}

/**
 * Presign a certificate upload.
 *
 * The MIME allow-list and size ceiling come from `RESOURCE_RULES['training-certificate']`, so the
 * DTO and the service cannot disagree about what is acceptable — a second hard-coded list here is
 * exactly how a surface ends up rejecting at one layer and accepting at the other.
 */
export const PresignCertificateSchema = z.object({
  fileName: z.string().min(1).max(255),
  mimeType: z.enum(CERTIFICATE_POLICY.allowedMimeTypes as unknown as [string, ...string[]]),
  sizeBytes: z.number().int().positive().max(CERTIFICATE_POLICY.maxSizeBytes),
  /** Base64 SHA-256 of the bytes. Optional, and compared on confirm when the backend reports one. */
  checksumSha256: z
    .string()
    .regex(/^[A-Za-z0-9+/]{43}=$/, 'Must be a base64-encoded SHA-256 digest')
    .optional(),
});
export class PresignCertificateDto extends createZodDto(PresignCertificateSchema) {}

// ── Responses ─────────────────────────────────────────────────────────────────

export class CourseResponseDto {
  id!: string;
  code!: string;
  title!: string;
  category!: string;
  provider!: string | null;
  description!: string | null;
  validityMonths!: number | null;
  retiredAt!: string | null;
  createdAt!: string;
}

export class RequirementResponseDto {
  id!: string;
  positionId!: string;
  courseId!: string;
  courseCode!: string;
  courseTitle!: string;
  kind!: string;
  graceDays!: number | null;
}

export class TrainingRecordResponseDto {
  id!: string;
  employeeId!: string;
  /**
   * Who completed the course, resolved server-side. Null when the employee row is gone — a training
   * record outlives the person who earned it, because "was this person trained when they did the
   * work" is a question an ISO competency audit asks about people who have since left. A left
   * lookup, never a join: an inner join would drop the record along with them.
   *
   * Null on the WRITE responses too (record, verify, revoke), deliberately. Those hand the row back
   * to a caller who just supplied the employee id, so resolving it would tell them what they passed
   * in — one directory query per mutation to restate the request.
   */
  employeeName!: string | null;
  courseId!: string;
  completedOn!: string;
  expiresOn!: string | null;
  result!: string | null;
  score!: string | null;
  status!: string;
  verifiedBy!: string | null;
  verifiedAt!: string | null;
  supersededById!: string | null;
  revokedReason!: string | null;
  notes!: string | null;
  createdAt!: string;
}

export class CertificateResponseDto {
  fileId!: string;
  fileName!: string;
  mimeType!: string;
  sizeBytes!: number;
  checksumSha256!: string | null;
  uploadedBy!: string;
  attachedBy!: string;
  attachedAt!: string;
}

export class PresignCertificateResponseDto {
  fileId!: string;
  /** PUT the bytes here within 5 minutes, then call confirm. */
  uploadUrl!: string;
  /**
   * Send EXACTLY these headers on the PUT — all of them, and nothing else.
   *
   * They are the headers the signature covers. Omitting one fails the signature and so does adding
   * an extra, and the failure arrives as a 403 with no CORS headers, which a browser reports as an
   * opaque network error rather than anything diagnosable.
   */
  requiredHeaders!: Record<string, string>;
}

export class DownloadUrlResponseDto {
  url!: string;
}

export class CompetencyGapResponseDto {
  employeeId!: string;
  /**
   * Who is missing the training, resolved server-side. Null when the employee row is gone; the gap
   * report is read from `employee_positions`, so a stale assignment can outlive the directory row it
   * points at, and a left lookup keeps the finding visible instead of quietly dropping it.
   *
   * Sent because the report exists to be acted on — somebody has to be booked onto a course — and a
   * column of uuids names nobody to book. `CoverageGapResponseDto` next door carries the same field
   * for the same reason; it just gets it from a join, because that report drives off `employees`.
   */
  employeeName!: string | null;
  positionId!: string;
  courseId!: string;
  courseCode!: string;
  courseTitle!: string;
  kind!: string;
  graceDays!: number | null;
  recordId!: string | null;
  completedOn!: string | null;
  expiresOn!: string | null;
  /** `never_completed` needs scheduling; `expired` needs rescheduling. */
  reason!: string;
}
