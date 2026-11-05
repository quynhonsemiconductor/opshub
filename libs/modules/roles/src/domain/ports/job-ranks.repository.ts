import type { DbExecutor } from '@platform';
import type {
  CreateJobRankInput,
  JobRank,
  JobRankWithBenefits,
  RankBenefit,
  UpdateJobRankInput,
} from '../job-ranks.types';

export const JOB_RANKS_REPOSITORY = Symbol('JOB_RANKS_REPOSITORY');

export interface IJobRanksRepository {
  /** Every rank with its benefits, most junior first. */
  list(): Promise<JobRankWithBenefits[]>;
  findById(id: string, tx?: DbExecutor): Promise<JobRankWithBenefits | null>;
  findByOrdinal(ordinal: number): Promise<JobRank | null>;
  /** Case-insensitive, matching the unique index on `lower(name)`. */
  findByName(name: string): Promise<JobRank | null>;
  create(input: CreateJobRankInput, tx?: DbExecutor): Promise<JobRank>;
  update(id: string, input: UpdateJobRankInput, tx?: DbExecutor): Promise<JobRank | null>;
  /** How many roles carry this rank; a rank in use cannot be deleted. */
  countRolesUsing(rankId: string): Promise<number>;
  delete(id: string, tx?: DbExecutor): Promise<void>;
  /** Replaces the rank's whole benefit set: a code left out of `benefits` is removed. */
  setBenefits(rankId: string, benefits: RankBenefit[], tx?: DbExecutor): Promise<void>;
}
