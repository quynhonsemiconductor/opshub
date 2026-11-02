import type { RankBenefitCode } from './rank-benefit-code.constants';

/** A seniority rank; `ordinal` 1 is the most junior. */
export interface JobRank {
  id: string;
  ordinal: number;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

/** One benefit a rank entitles its holders to, and its amount. */
export interface RankBenefit {
  benefitCode: RankBenefitCode;
  value: number;
}

export interface JobRankWithBenefits extends JobRank {
  benefits: RankBenefit[];
}

export interface CreateJobRankInput {
  ordinal: number;
  name: string;
}

export type UpdateJobRankInput = Partial<CreateJobRankInput>;
