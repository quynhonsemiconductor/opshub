import { Inject, Injectable } from '@nestjs/common';
import {
  ConflictException,
  ErrorCodes,
  InjectDrizzle,
  NotFoundException,
  type DrizzleDB,
} from '@platform';
import type { Actor } from '@shared-kernel';
import { AUDIT_ACTION, AUDIT_RESOURCE, AuditService } from '@modules/audit';
import {
  JOB_RANKS_REPOSITORY,
  type IJobRanksRepository,
} from '../domain/ports/job-ranks.repository';
import type {
  CreateJobRankInput,
  JobRank,
  JobRankWithBenefits,
  RankBenefit,
  UpdateJobRankInput,
} from '../domain/job-ranks.types';

/**
 * Job ranks and what each rank entitles its holders to.
 *
 * A rank is the seniority a position carries. Its benefits are rows (`rank_benefits`), one per
 * (rank, benefit), so a new benefit is a new row rather than a new column.
 */
@Injectable()
export class JobRanksService {
  constructor(
    @Inject(JOB_RANKS_REPOSITORY) private readonly repo: IJobRanksRepository,
    @InjectDrizzle() private readonly db: DrizzleDB,
    private readonly audit: AuditService,
  ) {}

  /**
   * Lists every rank with its benefits.
   *
   * Returns:
   *   The ranks, most junior first.
   */
  listRanks(): Promise<JobRankWithBenefits[]> {
    return this.repo.list();
  }

  /**
   * Reads one rank with its benefits.
   *
   * Args:
   *   id: The rank to read.
   *
   * Raises:
   *   NotFoundException: If no rank has this id.
   */
  async getRank(id: string): Promise<JobRankWithBenefits> {
    const rank = await this.repo.findById(id);
    if (!rank) throw new NotFoundException(ErrorCodes.JOB_RANK_NOT_FOUND, `Rank ${id} not found`);
    return rank;
  }

  /**
   * Creates a rank.
   *
   * Args:
   *   input: The ordinal (seniority order, 1 = most junior) and the name.
   *   actor: Who is creating it.
   *
   * Raises:
   *   ConflictException: If the ordinal or the name is already taken.
   */
  async createRank(input: CreateJobRankInput, actor: Actor): Promise<JobRank> {
    await this.assertOrdinalAndNameFree(input);
    return this.db.transaction(async (tx) => {
      const rank = await this.repo.create(input, tx);
      await this.audit.record(
        {
          actorId: actor.sub,
          actorEmail: actor.email,
          action: AUDIT_ACTION.JOB_RANK_CREATED,
          resourceType: AUDIT_RESOURCE.JOB_RANK,
          resourceId: rank.id,
          changes: { after: { ordinal: rank.ordinal, name: rank.name } },
        },
        tx,
      );
      return rank;
    });
  }

  /**
   * Renames a rank or moves it to another ordinal.
   *
   * Args:
   *   id: The rank to change.
   *   input: The fields to change.
   *   actor: Who is changing it.
   *
   * Raises:
   *   NotFoundException: If the rank does not exist.
   *   ConflictException: If the new ordinal or name belongs to another rank.
   */
  async updateRank(id: string, input: UpdateJobRankInput, actor: Actor): Promise<JobRank> {
    const before = await this.getRank(id);
    await this.assertOrdinalAndNameFree(input, id);
    return this.db.transaction(async (tx) => {
      const after = await this.repo.update(id, input, tx);
      await this.audit.record(
        {
          actorId: actor.sub,
          actorEmail: actor.email,
          action: AUDIT_ACTION.JOB_RANK_UPDATED,
          resourceType: AUDIT_RESOURCE.JOB_RANK,
          resourceId: id,
          changes: {
            before: { ordinal: before.ordinal, name: before.name },
            after: { ordinal: after!.ordinal, name: after!.name },
          },
        },
        tx,
      );
      return after!;
    });
  }

  /**
   * Replaces the whole benefit set of a rank.
   *
   * A benefit code left out of `benefits` is removed, so the caller always states the full picture.
   *
   * Args:
   *   rankId: The rank whose benefits are set.
   *   benefits: Every benefit the rank should carry, one entry per code.
   *   actor: Who is changing them.
   *
   * Returns:
   *   The rank with its new benefits.
   *
   * Raises:
   *   NotFoundException: If the rank does not exist.
   */
  async setRankBenefits(
    rankId: string,
    benefits: RankBenefit[],
    actor: Actor,
  ): Promise<JobRankWithBenefits> {
    const before = await this.getRank(rankId);
    await this.db.transaction(async (tx) => {
      await this.repo.setBenefits(rankId, benefits, tx);
      await this.audit.record(
        {
          actorId: actor.sub,
          actorEmail: actor.email,
          action: AUDIT_ACTION.JOB_RANK_BENEFITS_SET,
          resourceType: AUDIT_RESOURCE.JOB_RANK,
          resourceId: rankId,
          changes: { before: { benefits: before.benefits }, after: { benefits } },
        },
        tx,
      );
    });
    return this.getRank(rankId);
  }

  /**
   * Refuses an ordinal or a name that another rank already holds.
   *
   * Args:
   *   input: The ordinal and/or name about to be written.
   *   ownRankId: The rank being updated, which is allowed to keep its own values.
   */
  private async assertOrdinalAndNameFree(
    input: UpdateJobRankInput,
    ownRankId?: string,
  ): Promise<void> {
    if (input.ordinal !== undefined) {
      const holder = await this.repo.findByOrdinal(input.ordinal);
      if (holder && holder.id !== ownRankId) {
        throw new ConflictException(
          ErrorCodes.JOB_RANK_ORDINAL_TAKEN,
          `Ordinal ${input.ordinal} already belongs to rank '${holder.name}'`,
        );
      }
    }
    if (input.name !== undefined) {
      const holder = await this.repo.findByName(input.name);
      if (holder && holder.id !== ownRankId) {
        throw new ConflictException(
          ErrorCodes.JOB_RANK_NAME_TAKEN,
          `A rank named '${holder.name}' already exists`,
        );
      }
    }
  }
}
