import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { queryBoolean } from '@platform';
import { PaginationQuerySchema } from '@shared-kernel';
import { positionStatusEnum } from '@db/schema/enums';

const status = z.enum(positionStatusEnum.enumValues);

export const CreatePositionSchema = z.object({
  /** Uppercase pattern for the same reason document codes have one: it is quoted in plans. */
  code: z
    .string()
    .min(2)
    .max(32)
    .regex(/^[A-Z][A-Z0-9-]*$/, 'Use uppercase letters, digits and hyphens, e.g. ENG-QA-02'),
  title: z.string().min(2).max(160),
  department: z.string().min(2).max(120),
  rankId: z.string().uuid().optional(),
  /** At least 1: a position permitting nobody is a closed position, expressed by `status`. */
  headcount: z.number().int().min(1).max(10_000).optional(),
  description: z.string().max(5000).optional(),
});
export class CreatePositionDto extends createZodDto(CreatePositionSchema) {}

export const UpdatePositionSchema = z
  .object({
    title: z.string().min(2).max(160).optional(),
    department: z.string().min(2).max(120).optional(),
    rankId: z.string().uuid().nullable().optional(),
    headcount: z.number().int().min(1).max(10_000).optional(),
    description: z.string().max(5000).nullable().optional(),
    status: status.optional(),
  })
  // An empty PATCH is a no-op the caller almost certainly did not mean, and it would still write
  // an audit entry claiming a change.
  .refine((v) => Object.keys(v).length > 0, 'Supply at least one field to update');
export class UpdatePositionDto extends createZodDto(UpdatePositionSchema) {}

export const ListPositionsQuerySchema = z
  .object({
    /** Matches title, code or department. The SPA's search box sends this. */
    search: z.string().max(120).optional(),
    department: z.string().max(120).optional(),
    status: status.optional(),
    vacantOnly: queryBoolean().optional(),
  })
  .merge(PaginationQuerySchema);
export class ListPositionsQueryDto extends createZodDto(ListPositionsQuerySchema) {}

export const AssignPositionSchema = z.object({
  employeeId: z.string().uuid(),
  effectiveFrom: z.string().date(),
  /** Why the PREVIOUS assignment ended, when this is a transfer. Defaults to 'transfer'. */
  endReason: z.string().max(120).optional(),
});
export class AssignPositionDto extends createZodDto(AssignPositionSchema) {}

export const EndAssignmentSchema = z.object({
  effectiveTo: z.string().date(),
  endReason: z.string().max(120).optional(),
});
export class EndAssignmentDto extends createZodDto(EndAssignmentSchema) {}

export class PositionResponseDto {
  id!: string;
  code!: string;
  title!: string;
  department!: string;
  rankId!: string | null;
  headcount!: number;
  description!: string | null;
  status!: string;
  createdAt!: string;
}

export class PositionOccupancyResponseDto extends PositionResponseDto {
  /** Open assignments — someone who left last month does not occupy a slot. */
  filled!: number;
  /** `headcount - filled`, floored at 0: a reduced headcount must not report negative vacancies. */
  vacancies!: number;
}

/**
 * A HISTORY row, carrying the role it refers to.
 *
 * SEPARATE FROM `EmployeePositionResponseDto` rather than two optional fields on it. `/positions/me` is
 * `@SelfScoped` while every route that could turn a `positionId` into a title needs `position.read` — so a
 * self-service caller used to receive ids it had no way to resolve, and the only honest thing a screen
 * could render was a UUID.
 *
 * The assignment WRITES (`assign`, `endAssignment`) and `:id/assignments` keep the plain shape: those
 * callers hold `position.read` and already know which position they asked about, so resolving it again
 * would be a join to tell them what they passed in.
 */
export class EmployeePositionHistoryResponseDto {
  id!: string;
  employeeId!: string;
  positionId!: string;
  positionCode!: string;
  positionTitle!: string;
  effectiveFrom!: string;
  effectiveTo!: string | null;
  endReason!: string | null;
  createdAt!: string;
}

export class EmployeePositionResponseDto {
  id!: string;
  employeeId!: string;
  positionId!: string;
  effectiveFrom!: string;
  effectiveTo!: string | null;
  endReason!: string | null;
  createdAt!: string;
}

/**
 * Who holds a position — the same row with the PERSON named.
 *
 * A separate shape rather than a nullable field on the one above, for the reason its own docblock
 * gives about positions: the writes (`assign`, `endAssignment`) hand back the row to a caller who
 * just supplied the employee id, so resolving it would tell them what they passed in. Only the read
 * needs the name, and the SPA rendered `employeeId` there — a list headed "who holds this role"
 * answering with a uuid.
 */
export class PositionAssignmentResponseDto extends EmployeePositionResponseDto {
  /** Null when the employee row is gone. The assignment is still part of the position's history. */
  employeeName!: string | null;
}
