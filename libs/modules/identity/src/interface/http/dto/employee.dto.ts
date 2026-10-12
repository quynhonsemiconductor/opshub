import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PaginationQuerySchema } from '@shared-kernel';
import { employeeStatusEnum } from '@db/schema/enums';

// NOTE: Roles are intentionally NOT settable here. Role assignment is a
// governance action handled exclusively by the authz module
// (POST /v1/authz/assignments, guarded by `role.assign` + escalation check).
// This prevents privilege escalation via the directory/employee endpoints.
export const CreateEmployeeSchema = z.object({
  // Stored lower-cased and trimmed: an address is the identity the Graph worker checks a directory
  // object against, and `Ada@x` / `ada@x` must be one person (uq_employee_email_lower).
  email: z.string().trim().toLowerCase().email(),
  displayName: z.string().min(1).max(200),
  department: z.string().max(120).optional(),
  jobTitle: z.string().max(120).optional(),
  managerId: z.string().uuid().optional(),
  // A directory object id is a GUID. The Graph worker builds a URL from it and acts on that account, so
  // nothing else is accepted (and the worker still checks the object belongs to this employee).
  entraOid: z.string().uuid().optional(),
});

export class CreateEmployeeDto extends createZodDto(CreateEmployeeSchema) {}

export const ListEmployeesQuerySchema = z
  .object({
    status: z.enum(employeeStatusEnum.enumValues).optional(),
    department: z.string().optional(),
    search: z.string().optional(),
  })
  .merge(PaginationQuerySchema);

export class ListEmployeesQueryDto extends createZodDto(ListEmployeesQuerySchema) {}

// Roles are NOT updatable here — see CreateEmployeeSchema note. Use the authz
// module to grant/revoke roles.
export const UpdateEmployeeSchema = z.object({
  displayName: z.string().min(1).max(200).optional(),
  department: z.string().max(120).nullable().optional(),
  jobTitle: z.string().max(120).nullable().optional(),
  managerId: z.string().uuid().nullable().optional(),
});
export class UpdateEmployeeDto extends createZodDto(UpdateEmployeeSchema) {}

export const UpdateStatusSchema = z.object({
  status: z.enum(employeeStatusEnum.enumValues),
});
export class UpdateStatusDto extends createZodDto(UpdateStatusSchema) {}

export class EmployeeResponseDto {
  id!: string;
  email!: string;
  displayName!: string;
  department!: string | null;
  jobTitle!: string | null;
  managerId!: string | null;
  roles!: string[];
  status!: string;
  photoStorageKey!: string | null;
  createdAt!: string;
}

export const PresignAvatarSchema = z.object({
  fileName: z.string().min(1).max(255),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(5 * 1024 * 1024),
});
export class PresignAvatarDto extends createZodDto(PresignAvatarSchema) {}

export const ConfirmAvatarSchema = z.object({
  fileId: z.string().uuid(),
});
export class ConfirmAvatarDto extends createZodDto(ConfirmAvatarSchema) {}
