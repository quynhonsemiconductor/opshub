import { ApiProperty } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PaginationQuerySchema } from '@shared-kernel';
import { contractStatusEnum, contractTypeEnum, salaryPeriodEnum } from '@db/schema/enums';

const contractType = z.enum(contractTypeEnum.enumValues);
const contractStatus = z.enum(contractStatusEnum.enumValues);
const salaryPeriod = z.enum(salaryPeriodEnum.enumValues);

/**
 * Pay terms travel together or not at all, matching `ck_contract_salary_complete`.
 *
 * A decimal STRING, not a number: `numeric(14,2)` round-trips exactly through a string, while a
 * JSON number is an IEEE double — and a salary that arrives as 4999.999999999999 is worse than one
 * that fails validation.
 */
export const CompensationSchema = z.object({
  baseSalary: z
    .string()
    .regex(/^\d{1,12}(\.\d{1,2})?$/, 'Use a decimal amount with at most 2 places, e.g. "4500.00"')
    .refine((v) => Number(v) > 0, 'Salary must be greater than zero'),
  salaryCurrency: z
    .string()
    .length(3)
    .regex(/^[A-Z]{3}$/, 'ISO 4217, e.g. VND or USD'),
  salaryPeriod,
});

export const DraftContractSchema = z.object({
  employeeId: z.string().uuid(),
  roleId: z.string().uuid().nullable().optional(),
  /** Quoted in correspondence, so the same uppercase shape as role and document codes. */
  reference: z
    .string()
    .min(3)
    .max(40)
    .regex(/^[A-Z][A-Z0-9-]*$/, 'Use uppercase letters, digits and hyphens, e.g. EMP-2026-0042'),
  contractType,
  startDate: z.string().date(),
  /**
   * Required for every type except `permanent`, forbidden for it.
   *
   * The rule is NOT enforced here: it depends on `contractType`, and the service states it once
   * with the specific `CONTRACT_INVALID_TERM` code so that a PATCH changing only the type is
   * validated against the end date already stored. A `refine` here would answer the direct case
   * with a generic validation error and miss the patch case entirely.
   */
  endDate: z.string().date().nullable().optional(),
  probationEndDate: z.string().date().nullable().optional(),
  noticePeriodDays: z.number().int().min(0).max(365).optional(),
  compensation: CompensationSchema.nullable().optional(),
  documentId: z.string().uuid().nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
});
export class DraftContractDto extends createZodDto(DraftContractSchema) {}

export const UpdateContractSchema = DraftContractSchema.pick({
  roleId: true,
  contractType: true,
  startDate: true,
  endDate: true,
  probationEndDate: true,
  noticePeriodDays: true,
  compensation: true,
  documentId: true,
  notes: true,
})
  .partial()
  // An empty PATCH is a no-op the caller almost certainly did not mean, and it would still write an
  // audit entry claiming a change.
  .refine((v) => Object.keys(v).length > 0, 'Supply at least one field to update');
export class UpdateContractDto extends createZodDto(UpdateContractSchema) {}

export const ActivateContractSchema = z.object({
  /** Defaults to now when the contract already carries a signature date. */
  signedAt: z.string().datetime().optional(),
});
export class ActivateContractDto extends createZodDto(ActivateContractSchema) {}

export const RenewContractSchema = z.object({
  /** The drafted contract that takes over. Must be for the same employee. */
  incomingContractId: z.string().uuid(),
  /**
   * Signature date for the INCOMING contract.
   *
   * Needed for the same reason `activate` takes one: a contract may not go live unsigned. Without
   * it a renewal could only ever succeed against a draft that already carried a signature, which
   * made the route unusable — found by probing the live API.
   */
  signedAt: z.string().datetime().optional(),
});
export class RenewContractDto extends createZodDto(RenewContractSchema) {}

export const TerminateContractSchema = z.object({
  terminatedOn: z.string().date(),
  /** Required by `ck_contract_termination_reason`: a termination nobody can account for is worse
   * than none. */
  terminationReason: z.string().min(3).max(200),
});
export class TerminateContractDto extends createZodDto(TerminateContractSchema) {}

export const ListContractsQuerySchema = z
  .object({
    employeeId: z.string().uuid().optional(),
    status: contractStatus.optional(),
    contractType: contractType.optional(),
    roleId: z.string().uuid().optional(),
    /** Active contracts ending on or before this date — the renewal queue. */
    endingOnOrBefore: z.string().date().optional(),
  })
  .merge(PaginationQuerySchema);
export class ListContractsQueryDto extends createZodDto(ListContractsQuerySchema) {}

export class CompensationResponseDto {
  baseSalary!: string;
  salaryCurrency!: string;
  salaryPeriod!: string;
}

export class ContractResponseDto {
  id!: string;
  employeeId!: string;
  /**
   * The employee's display name, resolved server-side. Null when the employee row is gone — a
   * contract is exactly the record that has to outlive the person it was signed with.
   */
  employeeName!: string | null;
  roleId!: string | null;
  reference!: string;
  @ApiProperty({ enum: contractTypeEnum.enumValues })
  contractType!: (typeof contractTypeEnum.enumValues)[number];
  startDate!: string;
  endDate!: string | null;
  probationEndDate!: string | null;
  noticePeriodDays!: number;
  @ApiProperty({ enum: contractStatusEnum.enumValues })
  status!: (typeof contractStatusEnum.enumValues)[number];
  signedAt!: string | null;
  documentId!: string | null;
  terminatedOn!: string | null;
  terminationReason!: string | null;
  supersededById!: string | null;
  notes!: string | null;
  createdAt!: string;
  /**
   * Present only for a caller holding `contract.compensation.read`, or reading their OWN contract.
   *
   * `null` means "not visible to you", which is the same shape as "no pay terms recorded". That is
   * deliberate: distinguishing the two would tell a caller without the permission that a figure
   * exists, which is most of what the permission is protecting.
   */
  compensation!: CompensationResponseDto | null;
}
