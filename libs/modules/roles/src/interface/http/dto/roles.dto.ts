import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { queryBoolean } from '@platform';
import { PaginationQuerySchema } from '@shared-kernel';
import { roleStatusEnum } from '@db/schema/enums';

const status = z.enum(roleStatusEnum.enumValues);

export const CreateRoleSchema = z.object({
  /** Uppercase pattern for the same reason document codes have one: it is quoted in plans. */
  code: z
    .string()
    .min(2)
    .max(32)
    .regex(/^[A-Z][A-Z0-9-]*$/, 'Use uppercase letters, digits and hyphens, e.g. ENG-QA-02'),
  title: z.string().min(2).max(160),
  department: z.string().min(2).max(120),
  rankId: z.string().uuid().optional(),
  /** At least 1: a role permitting nobody is a closed role, expressed by `status`. */
  headcount: z.number().int().min(1).max(10_000).optional(),
  description: z.string().max(5000).optional(),
});
export class CreateRoleDto extends createZodDto(CreateRoleSchema) {}

export const UpdateRoleSchema = z
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
export class UpdateRoleDto extends createZodDto(UpdateRoleSchema) {}

export const ListRolesQuerySchema = z
  .object({
    /** Matches title, code or department. The SPA's search box sends this. */
    search: z.string().max(120).optional(),
    department: z.string().max(120).optional(),
    status: status.optional(),
    vacantOnly: queryBoolean().optional(),
  })
  .merge(PaginationQuerySchema);
export class ListRolesQueryDto extends createZodDto(ListRolesQuerySchema) {}

export const AssignRoleSchema = z.object({
  employeeId: z.string().uuid(),
  effectiveFrom: z.string().date(),
  /** Why the PREVIOUS assignment ended, when this is a transfer. Defaults to 'transfer'. */
  endReason: z.string().max(120).optional(),
});
export class AssignRoleDto extends createZodDto(AssignRoleSchema) {}

export const EndAssignmentSchema = z.object({
  effectiveTo: z.string().date(),
  endReason: z.string().max(120).optional(),
});
export class EndAssignmentDto extends createZodDto(EndAssignmentSchema) {}

export class RoleResponseDto {
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

export class RoleOccupancyResponseDto extends RoleResponseDto {
  /** Open assignments — someone who left last month does not occupy a slot. */
  filled!: number;
  /** `headcount - filled`, floored at 0: a reduced headcount must not report negative vacancies. */
  vacancies!: number;
}

/**
 * A HISTORY row, carrying the role it refers to.
 *
 * SEPARATE FROM `EmployeeRoleResponseDto` rather than two optional fields on it. `/roles/me` is
 * `@SelfScoped` while every route that could turn a `roleId` into a title needs `role.read` — so a
 * self-service caller used to receive ids it had no way to resolve, and the only honest thing a screen
 * could render was a UUID.
 *
 * The assignment WRITES (`assign`, `endAssignment`) and `:id/assignments` keep the plain shape: those
 * callers hold `role.read` and already know which role they asked about, so resolving it again
 * would be a join to tell them what they passed in.
 */
export class EmployeeRoleHistoryResponseDto {
  id!: string;
  employeeId!: string;
  roleId!: string;
  roleCode!: string;
  roleTitle!: string;
  effectiveFrom!: string;
  effectiveTo!: string | null;
  endReason!: string | null;
  createdAt!: string;
}

export class EmployeeRoleResponseDto {
  id!: string;
  employeeId!: string;
  roleId!: string;
  effectiveFrom!: string;
  effectiveTo!: string | null;
  endReason!: string | null;
  createdAt!: string;
}

/**
 * Who holds a role — the same row with the PERSON named.
 *
 * A separate shape rather than a nullable field on the one above, for the reason its own docblock
 * gives about roles: the writes (`assign`, `endAssignment`) hand back the row to a caller who
 * just supplied the employee id, so resolving it would tell them what they passed in. Only the read
 * needs the name, and the SPA rendered `employeeId` there — a list headed "who holds this role"
 * answering with a uuid.
 */
export class RoleAssignmentResponseDto extends EmployeeRoleResponseDto {
  /** Null when the employee row is gone. The assignment is still part of the role's history. */
  employeeName!: string | null;
}
