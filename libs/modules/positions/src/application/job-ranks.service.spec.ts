/**
 * JobRanksService — uniqueness refusals, and the audit entry that rides each write.
 *
 * The repository is a stub and the transaction a passthrough, so what is under test is this service's
 * decisions, not Drizzle. The unique indexes themselves are proven against a real database in the e2e suite.
 */
import { describe, expect, it, vi } from 'vitest';
import { ConflictException, NotFoundException, type DrizzleDB } from '@platform';
import { JobRanksService } from './job-ranks.service';
import type { JobRank, JobRankWithBenefits } from '../domain/job-ranks.types';
import { createFakeAudit } from '../../../audit/src/testing/audit.fake';

const ACTOR = { sub: 'actor-1', email: 'actor@opshub.local' };

function jobRank(overrides: Partial<JobRankWithBenefits> = {}): JobRankWithBenefits {
  return {
    id: 'rank-1',
    ordinal: 1,
    name: 'Junior',
    benefits: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeService(repoOverrides: Record<string, unknown> = {}) {
  const repo = {
    list: vi.fn().mockResolvedValue([jobRank()]),
    findById: vi.fn().mockResolvedValue(jobRank()),
    findByOrdinal: vi.fn().mockResolvedValue(null),
    findByName: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue(jobRank()),
    update: vi
      .fn()
      .mockImplementation((id: string, input: Partial<JobRank>) =>
        Promise.resolve(jobRank({ id, ...input })),
      ),
    setBenefits: vi.fn().mockResolvedValue(undefined),
    ...repoOverrides,
  };
  const transactionContext = { tx: true };
  const transaction = vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(transactionContext));
  const db = { transaction } as unknown as DrizzleDB;
  const audit = createFakeAudit();
  const service = new JobRanksService(repo, db, audit as never);
  return { service, repo, audit, transactionContext };
}

describe('createRank', () => {
  it('refuses an ordinal another rank already holds, before writing', async () => {
    const { service, repo } = makeService({
      findByOrdinal: vi.fn().mockResolvedValue(jobRank({ id: 'rank-9', name: 'Senior' })),
    });

    await expect(service.createRank({ ordinal: 3, name: 'Lead' }, ACTOR)).rejects.toThrow(
      ConflictException,
    );
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('refuses a name another rank already holds, before writing', async () => {
    const { service, repo } = makeService({
      findByName: vi.fn().mockResolvedValue(jobRank({ id: 'rank-9' })),
    });

    await expect(service.createRank({ ordinal: 2, name: 'junior' }, ACTOR)).rejects.toThrow(
      ConflictException,
    );
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('writes the audit entry inside the transaction', async () => {
    const { service, audit, transactionContext } = makeService();

    await service.createRank({ ordinal: 2, name: 'Mid' }, ACTOR);

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'job_rank.created' }),
      transactionContext,
    );
  });
});

describe('updateRank', () => {
  it('lets a rank keep its own ordinal and name', async () => {
    const { service, repo } = makeService({
      findByOrdinal: vi.fn().mockResolvedValue(jobRank({ id: 'rank-1' })),
      findByName: vi.fn().mockResolvedValue(jobRank({ id: 'rank-1' })),
    });

    await service.updateRank('rank-1', { ordinal: 1, name: 'Junior' }, ACTOR);

    expect(repo.update).toHaveBeenCalled();
  });

  it('refuses to move onto another rank’s ordinal', async () => {
    const { service } = makeService({
      findByOrdinal: vi.fn().mockResolvedValue(jobRank({ id: 'rank-2' })),
    });

    await expect(service.updateRank('rank-1', { ordinal: 2 }, ACTOR)).rejects.toThrow(
      ConflictException,
    );
  });

  it('answers 404 for a rank that does not exist', async () => {
    const { service } = makeService({ findById: vi.fn().mockResolvedValue(null) });

    await expect(service.updateRank('missing', { name: 'X' }, ACTOR)).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('setRankBenefits', () => {
  it('replaces the set and records before and after in one transaction', async () => {
    const before = jobRank({ benefits: [{ benefitCode: 'wfh_weekly_days', value: 1 }] });
    const { service, repo, audit, transactionContext } = makeService({
      findById: vi.fn().mockResolvedValue(before),
    });
    const benefits = [{ benefitCode: 'wfh_weekly_days' as const, value: 2 }];

    await service.setRankBenefits('rank-1', benefits, ACTOR);

    expect(repo.setBenefits).toHaveBeenCalledWith('rank-1', benefits, transactionContext);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'job_rank.benefits_set',
        changes: { before: { benefits: before.benefits }, after: { benefits } },
      }),
      transactionContext,
    );
  });
});
