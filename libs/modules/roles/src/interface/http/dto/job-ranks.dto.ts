import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { rankBenefitCodeEnum } from '@db/schema/enums';
import {
  JOB_RANK_NAME_MAX_LENGTH,
  JOB_RANK_ORDINAL_MAX,
  RANK_BENEFIT_VALUE_MAX,
} from '../../../roles.constants';

const rankBenefitCode = z.enum(rankBenefitCodeEnum.enumValues);

export const CreateJobRankSchema = z.object({
  /** Seniority order, 1 = most junior. */
  ordinal: z.number().int().min(1).max(JOB_RANK_ORDINAL_MAX),
  name: z.string().trim().min(1).max(JOB_RANK_NAME_MAX_LENGTH),
});
export class CreateJobRankDto extends createZodDto(CreateJobRankSchema) {}

export const UpdateJobRankSchema = z
  .object({
    ordinal: z.number().int().min(1).max(JOB_RANK_ORDINAL_MAX).optional(),
    name: z.string().trim().min(1).max(JOB_RANK_NAME_MAX_LENGTH).optional(),
  })
  // An empty PATCH is a no-op the caller almost certainly did not mean, and it would still write an
  // audit entry claiming a change.
  .refine((v) => Object.keys(v).length > 0, 'Supply at least one field to update');
export class UpdateJobRankDto extends createZodDto(UpdateJobRankSchema) {}

export const SetRankBenefitsSchema = z.object({
  benefits: z
    .array(
      z.object({
        benefitCode: rankBenefitCode,
        value: z.number().int().min(0).max(RANK_BENEFIT_VALUE_MAX),
      }),
    )
    .refine(
      (benefits) => new Set(benefits.map((b) => b.benefitCode)).size === benefits.length,
      'Each benefit code may appear once',
    ),
});
export class SetRankBenefitsDto extends createZodDto(SetRankBenefitsSchema) {}

export class RankBenefitResponseDto {
  benefitCode!: string;
  value!: number;
}

export class JobRankResponseDto {
  id!: string;
  ordinal!: number;
  name!: string;
  benefits!: RankBenefitResponseDto[];
  createdAt!: string;
  updatedAt!: string;
}
