import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { queryBoolean } from '@platform';
import { PaginationQuerySchema } from '@shared-kernel';
import { licenseTypeEnum, licenseStatusEnum } from '@db/schema/enums';

const licenseTypeZ = z.enum(licenseTypeEnum.enumValues);
const licenseStatusZ = z.enum(licenseStatusEnum.enumValues);

export const CreateLicenseSchema = z.object({
  name: z.string().min(1).max(150),
  vendor: z.string().min(1).max(120),
  /**
   * The supplier in the ISMS vendor register, when they are in it.
   *
   * Optional and alongside the free-text `vendor`, not instead of it — see `db/schema/licenses.ts`.
   * Setting it is what puts this licence into the vendor-spend join and out of the
   * `unassessed-spend` report.
   */
  vendorId: z.string().uuid().optional().nullable(),
  licenseType: licenseTypeZ,
  seatCount: z.number().int().positive().optional().nullable(),
  costPerSeatCents: z.number().int().nonnegative().optional().nullable(),
  renewalDate: z.string().date().optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  externalId: z.string().max(200).optional().nullable(),
});
export class CreateLicenseDto extends createZodDto(CreateLicenseSchema) {}

export const UpdateLicenseSchema = z.object({
  name: z.string().min(1).max(150).optional(),
  vendor: z.string().min(1).max(120).optional(),
  vendorId: z.string().uuid().optional().nullable(),
  licenseType: licenseTypeZ.optional(),
  seatCount: z.number().int().positive().optional().nullable(),
  costPerSeatCents: z.number().int().nonnegative().optional().nullable(),
  renewalDate: z.string().date().optional().nullable(),
  status: licenseStatusZ.optional(),
  notes: z.string().max(2000).optional().nullable(),
  externalId: z.string().max(200).optional().nullable(),
});
export class UpdateLicenseDto extends createZodDto(UpdateLicenseSchema) {}

export const ListLicensesQuerySchema = z
  .object({
    status: licenseStatusZ.optional(),
    vendor: z.string().optional(),
    search: z.string().optional(),
  })
  .merge(PaginationQuerySchema);
export class ListLicensesQueryDto extends createZodDto(ListLicensesQuerySchema) {}

export const AssignSeatSchema = z.object({
  employeeId: z.string().uuid(),
  notes: z.string().max(500).optional().nullable(),
});
export class AssignSeatDto extends createZodDto(AssignSeatSchema) {}

export const ListAssignmentsQuerySchema = z.object({
  includeRevoked: queryBoolean().default(false),
});
export class ListAssignmentsQueryDto extends createZodDto(ListAssignmentsQuerySchema) {}

export class LicenseResponseDto {
  id!: string;
  name!: string;
  vendor!: string;
  /** The linked supplier in the ISMS register, or null when nobody has linked one. */
  vendorId!: string | null;
  licenseType!: string;
  seatCount!: number | null;
  costPerSeatCents!: number | null;
  renewalDate!: string | null;
  status!: string;
  notes!: string | null;
  externalId!: string | null;
  createdAt!: string;
  updatedAt!: string;
}

export class LicenseAssignmentResponseDto {
  id!: string;
  licenseId!: string;
  employeeId!: string;
  /**
   * Who holds the seat, resolved server-side. Null when the employee row is gone — the assignment
   * outlives them on purpose, because a revoked seat is the row a vendor true-up reconciles against
   * an invoice, and "who had a Photoshop seat in March" has to stay answerable after a leaver's
   * directory record has been removed. A left lookup, never a join.
   *
   * Null on the assign response too: that write hands the row back to a caller who just supplied the
   * employee id, and the SPA discards it and refetches the list.
   */
  employeeName!: string | null;
  assignedAt!: string;
  revokedAt!: string | null;
  notes!: string | null;
}

export class LicenseUtilizationDto {
  licenseId!: string;
  name!: string;
  vendor!: string;
  seatCount!: number | null;
  usedSeats!: number;
  availableSeats!: number | null;
  utilizationPct!: number | null;
  monthlySpendCents!: number | null;
}
