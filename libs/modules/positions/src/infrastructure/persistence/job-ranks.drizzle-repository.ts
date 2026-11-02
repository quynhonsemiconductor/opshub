import { Injectable } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import { InjectDrizzle, type DbExecutor, type DrizzleDB } from '@platform';
import { newId } from '@shared-kernel';
import { jobRanks, positions, rankBenefits } from '../../../../../../db/schema';
import type { IJobRanksRepository } from '../../domain/ports/job-ranks.repository';
import type {
  CreateJobRankInput,
  JobRank,
  JobRankWithBenefits,
  RankBenefit,
  UpdateJobRankInput,
} from '../../domain/job-ranks.types';

@Injectable()
export class JobRanksDrizzleRepository implements IJobRanksRepository {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  async list(): Promise<JobRankWithBenefits[]> {
    const [rankRows, benefitRows] = await Promise.all([
      this.db.select().from(jobRanks).orderBy(asc(jobRanks.ordinal), asc(jobRanks.id)),
      this.db
        .select()
        .from(rankBenefits)
        .orderBy(asc(rankBenefits.rankId), asc(rankBenefits.benefitCode)),
    ]);
    const benefitsByRank = new Map<string, RankBenefit[]>();
    for (const row of benefitRows) {
      const benefitsOfRank = benefitsByRank.get(row.rankId) ?? [];
      benefitsOfRank.push({ benefitCode: row.benefitCode, value: row.value });
      benefitsByRank.set(row.rankId, benefitsOfRank);
    }
    return rankRows.map((rank) => ({ ...rank, benefits: benefitsByRank.get(rank.id) ?? [] }));
  }

  async findById(id: string, tx?: DbExecutor): Promise<JobRankWithBenefits | null> {
    const executor = tx ?? this.db;
    const [rank] = await executor.select().from(jobRanks).where(eq(jobRanks.id, id)).limit(1);
    if (!rank) return null;
    const benefitRows = await executor
      .select()
      .from(rankBenefits)
      .where(eq(rankBenefits.rankId, id))
      .orderBy(asc(rankBenefits.rankId), asc(rankBenefits.benefitCode));
    return {
      ...rank,
      benefits: benefitRows.map((row) => ({ benefitCode: row.benefitCode, value: row.value })),
    };
  }

  async findByOrdinal(ordinal: number): Promise<JobRank | null> {
    const [row] = await this.db
      .select()
      .from(jobRanks)
      .where(eq(jobRanks.ordinal, ordinal))
      .limit(1);
    return row ?? null;
  }

  async findByName(name: string): Promise<JobRank | null> {
    const [row] = await this.db
      .select()
      .from(jobRanks)
      .where(sql`lower(${jobRanks.name}) = lower(${name})`)
      .limit(1);
    return row ?? null;
  }

  async create(input: CreateJobRankInput, tx?: DbExecutor): Promise<JobRank> {
    const [row] = await (tx ?? this.db)
      .insert(jobRanks)
      .values({ id: newId(), ordinal: input.ordinal, name: input.name })
      .returning();
    return row;
  }

  async update(id: string, input: UpdateJobRankInput, tx?: DbExecutor): Promise<JobRank | null> {
    const [row] = await (tx ?? this.db)
      .update(jobRanks)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(jobRanks.id, id))
      .returning();
    return row ?? null;
  }

  async countPositionsUsing(rankId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(positions)
      .where(eq(positions.rankId, rankId));
    return row?.count ?? 0;
  }

  async delete(id: string, tx?: DbExecutor): Promise<void> {
    await (tx ?? this.db).delete(jobRanks).where(eq(jobRanks.id, id));
  }

  async setBenefits(rankId: string, benefits: RankBenefit[], outer?: DbExecutor): Promise<void> {
    await (outer ?? this.db).transaction(async (tx) => {
      await tx.delete(rankBenefits).where(eq(rankBenefits.rankId, rankId));
      if (benefits.length > 0) {
        await tx.insert(rankBenefits).values(
          benefits.map((benefit) => ({
            rankId,
            benefitCode: benefit.benefitCode,
            value: benefit.value,
          })),
        );
      }
    });
  }
}
