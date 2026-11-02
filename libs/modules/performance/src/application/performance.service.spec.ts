/**
 * PerformanceService — the five rules the database cannot hold, and the refusals around them.
 *
 * WHY UNIT TESTS WHEN THERE IS AN E2E SUITE. `performance.e2e.spec.ts` drives the real API, the real
 * CHECKs and the real request engine, which is the only place those can be proven. What it cannot do
 * cheaply is enumerate the GOAL-WEIGHT grid (a set totalling 90, one totalling 110, one ungraded goal,
 * an empty set), pin that a refusal happens BEFORE any write, or pin that each audit entry receives
 * the transaction rather than the pool — a fire-and-forget write survives a rolled-back change and
 * leaves a trail claiming something that did not happen.
 *
 * The repository is a stub and the transaction a passthrough, so what is under test is this service's
 * decisions, not Drizzle.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ConflictException,
  NotFoundException,
  PreconditionFailedException,
  type DrizzleDB,
} from '@platform';
import { PerformanceService } from './performance.service';
import type {
  PerformanceCycle,
  PerformanceGoal,
  PerformanceRatingLevel,
  PerformanceReview,
} from '../domain/performance.types';
import { createFakeAudit } from '../../../audit/src/testing/audit.fake';

const ACTOR = { sub: 'reviewer-1', email: 'reviewer@opshub.local' };
const EMPLOYEE = 'employee-1';

function cycle(over: Partial<PerformanceCycle> = {}): PerformanceCycle {
  return {
    id: 'cyc-1',
    reference: 'PR-2031-H1',
    name: 'First half 2031',
    periodStart: '2031-01-01',
    periodEnd: '2031-06-30',
    selfAssessmentDue: null,
    reviewDue: '2031-07-31',
    status: 'open',
    openedAt: new Date(),
    closedAt: null,
    createdBy: 'hr-1',
    createdAt: new Date(),
    ...over,
  };
}

function review(over: Partial<PerformanceReview> = {}): PerformanceReview {
  return {
    id: 'rev-1',
    cycleId: 'cyc-1',
    employeeId: EMPLOYEE,
    reviewerId: ACTOR.sub,
    roleId: 'pos-1',
    status: 'manager_review',
    selfAssessment: 'I did the things',
    selfAssessmentSubmittedAt: new Date(),
    managerSummary: 'A good half',
    overallRating: 'meets',
    developmentPlan: null,
    ratedAt: new Date(),
    requestId: null,
    approvedBy: null,
    approvedAt: null,
    acknowledgedAt: null,
    createdBy: 'hr-1',
    createdAt: new Date(),
    ...over,
  };
}

function goal(over: Partial<PerformanceGoal> = {}): PerformanceGoal {
  return {
    id: 'goal-1',
    reviewId: 'rev-1',
    title: 'Ship the thing',
    description: null,
    target: null,
    weight: '100.00',
    outcome: null,
    rating: 'meets',
    ...over,
  };
}

function level(over: Partial<PerformanceRatingLevel> = {}): PerformanceRatingLevel {
  return {
    code: 'meets',
    rank: 3,
    label: 'Meets expectations',
    description: 'Did the job the role asks for',
    requiresDevelopmentPlan: false,
    ...over,
  };
}

function makeService(repoOver: Record<string, unknown> = {}) {
  const repo = {
    listRatingScale: vi.fn().mockResolvedValue([level()]),
    findRatingLevel: vi.fn().mockResolvedValue(level()),
    createCycle: vi
      .fn()
      .mockImplementation((input: Record<string, unknown>) =>
        Promise.resolve(cycle(input as Partial<PerformanceCycle>)),
      ),
    findCycleById: vi.fn().mockResolvedValue(cycle()),
    findCycleByReference: vi.fn().mockResolvedValue(null),
    listCycles: vi.fn().mockResolvedValue({ rows: [], total: 0 }),
    openCycle: vi.fn().mockResolvedValue(cycle({ status: 'open' })),
    closeCycle: vi.fn().mockResolvedValue(cycle({ status: 'closed', closedAt: new Date() })),
    createReview: vi
      .fn()
      .mockImplementation((input: Record<string, unknown>) =>
        Promise.resolve(review(input as Partial<PerformanceReview>)),
      ),
    findReviewById: vi.fn().mockResolvedValue(review()),
    findReviewForEmployee: vi.fn().mockResolvedValue(null),
    listReviews: vi.fn().mockResolvedValue({ rows: [], total: 0 }),
    reassignReviewer: vi.fn().mockResolvedValue(review({ reviewerId: 'reviewer-2' })),
    submitSelfAssessment: vi.fn().mockResolvedValue(review({ status: 'manager_review' })),
    recordRating: vi.fn().mockResolvedValue(review()),
    markPendingApproval: vi.fn().mockResolvedValue(review({ status: 'pending_approval' })),
    markShared: vi.fn().mockResolvedValue(review({ status: 'shared' })),
    returnToReviewer: vi.fn().mockResolvedValue(review({ status: 'manager_review' })),
    acknowledge: vi
      .fn()
      .mockResolvedValue(review({ status: 'acknowledged', acknowledgedAt: new Date() })),
    cancelReview: vi.fn().mockResolvedValue(review({ status: 'cancelled' })),
    setGoal: vi
      .fn()
      .mockImplementation((input: Record<string, unknown>) =>
        Promise.resolve(
          goal({ ...(input as Partial<PerformanceGoal>), weight: String(input.weight) }),
        ),
      ),
    listGoals: vi.fn().mockResolvedValue([goal()]),
    removeGoal: vi.fn().mockResolvedValue(goal()),
    rateGoal: vi.fn().mockResolvedValue(goal()),
    coverageGaps: vi.fn().mockResolvedValue([]),
    cycleProgress: vi.fn().mockResolvedValue([]),
    countUnfinishedReviews: vi.fn().mockResolvedValue(0),
    ...repoOver,
  };
  const TX = { tx: true };
  const transaction = vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(TX));
  const db = { transaction } as unknown as DrizzleDB;
  const audit = createFakeAudit();
  const engine = { submit: vi.fn().mockResolvedValue({ id: 'req-1' }) };
  const roles = { currentAssignment: vi.fn().mockResolvedValue({ roleId: 'pos-9' }) };

  // `repo` needs NO widening — the stub covers every method of `IPerformanceRepository`, which is
  // the point: a missing method here would be a type error rather than an `undefined` at run time.
  // The other three are widened because they stand in for classes, not interfaces.
  const service = new PerformanceService(repo, db, audit as never, engine as never, roles as never);
  return { service, repo, db, transaction, audit, engine, roles, TX };
}

describe('createCycle', () => {
  it('refuses a review deadline before the period has ended', async () => {
    const { service, repo } = makeService();
    await expect(
      service.createCycle(
        {
          reference: 'PR-X',
          name: 'x',
          periodStart: '2031-01-01',
          periodEnd: '2031-06-30',
          reviewDue: '2031-05-01',
        },
        ACTOR,
      ),
    ).rejects.toThrow(PreconditionFailedException);
    expect(repo.createCycle).not.toHaveBeenCalled();
  });

  it('refuses a duplicate reference before writing anything', async () => {
    const { service, repo } = makeService({
      findCycleByReference: vi.fn().mockResolvedValue(cycle()),
    });
    await expect(
      service.createCycle(
        {
          reference: 'PR-2031-H1',
          name: 'x',
          periodStart: '2031-01-01',
          periodEnd: '2031-06-30',
          reviewDue: '2031-07-31',
        },
        ACTOR,
      ),
    ).rejects.toThrow(ConflictException);
    expect(repo.createCycle).not.toHaveBeenCalled();
  });

  it('writes its audit entry inside the transaction', async () => {
    const { service, audit, TX } = makeService();
    await service.createCycle(
      {
        reference: 'PR-Y',
        name: 'x',
        periodStart: '2031-01-01',
        periodEnd: '2031-06-30',
        reviewDue: '2031-07-31',
      },
      ACTOR,
    );
    // A fire-and-forget write would survive a rolled-back insert and claim a cycle exists.
    expect(audit.record).toHaveBeenCalledWith(expect.anything(), TX);
  });
});

describe('closeCycle', () => {
  it('refuses while any review is still in flight, and does not close', async () => {
    const { service, repo } = makeService({ countUnfinishedReviews: vi.fn().mockResolvedValue(3) });
    await expect(service.closeCycle('cyc-1', ACTOR)).rejects.toThrow(PreconditionFailedException);
    expect(repo.closeCycle).not.toHaveBeenCalled();
  });

  it('counts the unfinished reviews INSIDE the transaction', async () => {
    // Counting on the pool would read a snapshot the close does not commit in, so a review created
    // between the two would slip through the gate.
    const { service, repo, TX } = makeService();
    await service.closeCycle('cyc-1', ACTOR);
    expect(repo.countUnfinishedReviews).toHaveBeenCalledWith('cyc-1', TX);
  });
});

describe('createReview', () => {
  it('refuses a cycle that is not open', async () => {
    const { service, repo } = makeService({
      findCycleById: vi.fn().mockResolvedValue(cycle({ status: 'draft', openedAt: null })),
    });
    await expect(
      service.createReview(
        { cycleId: 'cyc-1', employeeId: EMPLOYEE, reviewerId: ACTOR.sub },
        ACTOR,
      ),
    ).rejects.toThrow(PreconditionFailedException);
    expect(repo.createReview).not.toHaveBeenCalled();
  });

  it('refuses a self-review before writing anything', async () => {
    // Also `ck_review_reviewer_not_employee`; restated so the caller gets a code rather than a 500.
    const { service, repo } = makeService();
    await expect(
      service.createReview({ cycleId: 'cyc-1', employeeId: EMPLOYEE, reviewerId: EMPLOYEE }, ACTOR),
    ).rejects.toThrow(PreconditionFailedException);
    expect(repo.createReview).not.toHaveBeenCalled();
  });

  it('refuses a second review for the same employee in the cycle', async () => {
    const { service, repo } = makeService({
      findReviewForEmployee: vi.fn().mockResolvedValue(review()),
    });
    await expect(
      service.createReview(
        { cycleId: 'cyc-1', employeeId: EMPLOYEE, reviewerId: ACTOR.sub },
        ACTOR,
      ),
    ).rejects.toThrow(ConflictException);
    expect(repo.createReview).not.toHaveBeenCalled();
  });

  it("FREEZES the employee's current role onto the review", async () => {
    const { service, repo, roles } = makeService();
    await service.createReview(
      { cycleId: 'cyc-1', employeeId: EMPLOYEE, reviewerId: ACTOR.sub },
      ACTOR,
    );
    expect(roles.currentAssignment).toHaveBeenCalledWith(EMPLOYEE);
    expect(repo.createReview).toHaveBeenCalledWith(
      expect.objectContaining({ roleId: 'pos-9' }),
      expect.anything(),
    );
  });

  it('creates the review with no role when the employee has no assignment', async () => {
    // Being between roles is not a reason to refuse somebody a review.
    const { service, repo, roles } = makeService();
    roles.currentAssignment.mockResolvedValue(null);

    await service.createReview(
      { cycleId: 'cyc-1', employeeId: EMPLOYEE, reviewerId: ACTOR.sub },
      ACTOR,
    );
    expect(repo.createReview).toHaveBeenCalledWith(
      expect.objectContaining({ roleId: null }),
      expect.anything(),
    );
  });
});

describe('rate', () => {
  it('refuses anybody who is not the assigned reviewer', async () => {
    const { service, repo } = makeService({
      findReviewById: vi.fn().mockResolvedValue(review({ reviewerId: 'somebody-else' })),
    });
    await expect(
      service.rate('rev-1', { managerSummary: 'x'.repeat(30), overallRating: 'meets' }, ACTOR),
    ).rejects.toThrow(PreconditionFailedException);
    expect(repo.recordRating).not.toHaveBeenCalled();
  });

  it('refuses a rating that demands a development plan when none was written', async () => {
    const { service, repo } = makeService({
      findRatingLevel: vi
        .fn()
        .mockResolvedValue(
          level({ code: 'needs_improvement', rank: 2, requiresDevelopmentPlan: true }),
        ),
    });
    await expect(
      service.rate(
        'rev-1',
        { managerSummary: 'x'.repeat(30), overallRating: 'needs_improvement' },
        ACTOR,
      ),
    ).rejects.toThrow(PreconditionFailedException);
    expect(repo.recordRating).not.toHaveBeenCalled();
  });

  it('treats a whitespace-only development plan as none', async () => {
    // Otherwise the gate is satisfied by a space, which is the same as not having one.
    const { service, repo } = makeService({
      findRatingLevel: vi
        .fn()
        .mockResolvedValue(
          level({ code: 'unsatisfactory', rank: 1, requiresDevelopmentPlan: true }),
        ),
    });
    await expect(
      service.rate(
        'rev-1',
        { managerSummary: 'x'.repeat(30), overallRating: 'unsatisfactory', developmentPlan: '   ' },
        ACTOR,
      ),
    ).rejects.toThrow(PreconditionFailedException);
    expect(repo.recordRating).not.toHaveBeenCalled();
  });

  it('accepts a low rating that HAS a plan, and stores it trimmed', async () => {
    const { service, repo } = makeService({
      findRatingLevel: vi
        .fn()
        .mockResolvedValue(
          level({ code: 'unsatisfactory', rank: 1, requiresDevelopmentPlan: true }),
        ),
    });
    await service.rate(
      'rev-1',
      {
        managerSummary: 'x'.repeat(30),
        overallRating: 'unsatisfactory',
        developmentPlan: '  weekly coaching  ',
      },
      ACTOR,
    );
    expect(repo.recordRating).toHaveBeenCalledWith(
      'rev-1',
      expect.objectContaining({ developmentPlan: 'weekly coaching' }),
      expect.anything(),
    );
  });

  it('rates each goal WITH the review id, so a foreign goal cannot be reached', async () => {
    const { service, repo, TX } = makeService();
    await service.rate(
      'rev-1',
      {
        managerSummary: 'x'.repeat(30),
        overallRating: 'meets',
        goals: [{ id: 'goal-1', rating: 'exceeds' }],
      },
      ACTOR,
    );
    expect(repo.rateGoal).toHaveBeenCalledWith(
      'goal-1',
      'rev-1',
      expect.objectContaining({ rating: 'exceeds' }),
      TX,
    );
  });

  it('fails the whole rating when a named goal is not on this review', async () => {
    // Inside the transaction, so the overall rating rolls back with it — a rating recorded against
    // goals that were not updated is a number with nothing behind it.
    const { service } = makeService({ rateGoal: vi.fn().mockResolvedValue(null) });
    await expect(
      service.rate(
        'rev-1',
        {
          managerSummary: 'x'.repeat(30),
          overallRating: 'meets',
          goals: [{ id: 'goal-from-elsewhere', rating: 'meets' }],
        },
        ACTOR,
      ),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('submitForApproval', () => {
  it('refuses anybody who is not the assigned reviewer', async () => {
    const { service, engine } = makeService({
      findReviewById: vi.fn().mockResolvedValue(review({ reviewerId: 'somebody-else' })),
    });
    await expect(service.submitForApproval('rev-1', ACTOR)).rejects.toThrow(
      PreconditionFailedException,
    );
    expect(engine.submit).not.toHaveBeenCalled();
  });

  it('refuses an unrated review', async () => {
    const { service, engine } = makeService({
      findReviewById: vi
        .fn()
        .mockResolvedValue(review({ overallRating: null, managerSummary: null })),
    });
    await expect(service.submitForApproval('rev-1', ACTOR)).rejects.toThrow(
      PreconditionFailedException,
    );
    expect(engine.submit).not.toHaveBeenCalled();
  });

  it('refuses goal weights that do not total 100', async () => {
    const { service, engine } = makeService({
      listGoals: vi
        .fn()
        .mockResolvedValue([
          goal({ id: 'g1', weight: '60.00' }),
          goal({ id: 'g2', title: 'b', weight: '30.00' }),
        ]),
    });
    await expect(service.submitForApproval('rev-1', ACTOR)).rejects.toThrow(
      PreconditionFailedException,
    );
    expect(engine.submit).not.toHaveBeenCalled();
  });

  it('refuses weights that overshoot 100 as well as undershoot', async () => {
    const { service, engine } = makeService({
      listGoals: vi
        .fn()
        .mockResolvedValue([
          goal({ id: 'g1', weight: '70.00' }),
          goal({ id: 'g2', title: 'b', weight: '40.00' }),
        ]),
    });
    await expect(service.submitForApproval('rev-1', ACTOR)).rejects.toThrow(
      PreconditionFailedException,
    );
    expect(engine.submit).not.toHaveBeenCalled();
  });

  it('accepts a set that totals 100 across several goals', async () => {
    const { service, engine } = makeService({
      listGoals: vi
        .fn()
        .mockResolvedValue([
          goal({ id: 'g1', weight: '33.34' }),
          goal({ id: 'g2', title: 'b', weight: '33.33' }),
          goal({ id: 'g3', title: 'c', weight: '33.33' }),
        ]),
    });
    await service.submitForApproval('rev-1', ACTOR);
    expect(engine.submit).toHaveBeenCalled();
  });

  it('refuses an ungraded goal, naming it', async () => {
    const { service, engine } = makeService({
      listGoals: vi
        .fn()
        .mockResolvedValue([goal({ weight: '100.00', rating: null, title: 'Unrated thing' })]),
    });
    await expect(service.submitForApproval('rev-1', ACTOR)).rejects.toThrow(/Unrated thing/);
    expect(engine.submit).not.toHaveBeenCalled();
  });

  it('accepts a review with NO goals at all', async () => {
    // The first cycle an organisation runs has nobody's goals from the year before, and refusing
    // every review for that reason would make the feature unusable exactly when it is introduced.
    const { service, engine } = makeService({ listGoals: vi.fn().mockResolvedValue([]) });
    await service.submitForApproval('rev-1', ACTOR);
    expect(engine.submit).toHaveBeenCalled();
  });

  it('stores the engine request id on the review', async () => {
    const { service, repo } = makeService();
    await service.submitForApproval('rev-1', ACTOR);
    expect(repo.markPendingApproval).toHaveBeenCalledWith('rev-1', 'req-1', expect.anything());
  });
});

describe('goal editing', () => {
  it('refuses once the review has been submitted for sign-off', async () => {
    // Changing what somebody was judged against after they were judged is not an edit.
    const { service, repo } = makeService({
      findReviewById: vi.fn().mockResolvedValue(review({ status: 'pending_approval' })),
    });
    await expect(
      service.setGoal({ reviewId: 'rev-1', title: 'New goal', weight: 50 }, ACTOR),
    ).rejects.toThrow(PreconditionFailedException);
    expect(repo.setGoal).not.toHaveBeenCalled();
  });

  it('refuses on an acknowledged review with a SETTLED code, not a state code', async () => {
    const { service } = makeService({
      findReviewById: vi
        .fn()
        .mockResolvedValue(review({ status: 'acknowledged', acknowledgedAt: new Date() })),
    });
    await expect(
      service.setGoal({ reviewId: 'rev-1', title: 'New goal', weight: 50 }, ACTOR),
    ).rejects.toThrow(ConflictException);
  });

  it('refuses to remove a goal that belongs to another review', async () => {
    const { service } = makeService({
      removeGoal: vi.fn().mockResolvedValue(goal({ reviewId: 'another-review' })),
    });
    await expect(service.removeGoal('rev-1', 'goal-1', ACTOR)).rejects.toThrow(NotFoundException);
  });
});

describe('transitions refuse from the wrong state', () => {
  it('reports a failed self-assessment submission as a state error', async () => {
    // The repository guards on `status = 'self_assessment'` and returns null; the service turns that
    // into a coded refusal rather than a silent success.
    const { service } = makeService({ submitSelfAssessment: vi.fn().mockResolvedValue(null) });
    await expect(service.submitSelfAssessment('rev-1', 'x'.repeat(30), ACTOR)).rejects.toThrow(
      PreconditionFailedException,
    );
  });

  it('reports a failed acknowledgement as a state error', async () => {
    const { service } = makeService({ acknowledge: vi.fn().mockResolvedValue(null) });
    await expect(service.acknowledge('rev-1', ACTOR)).rejects.toThrow(PreconditionFailedException);
  });

  it('reports a failed cancellation as SETTLED — the review was already seen', async () => {
    const { service } = makeService({ cancelReview: vi.fn().mockResolvedValue(null) });
    await expect(service.cancelReview('rev-1', 'no longer needed', ACTOR)).rejects.toThrow(
      PreconditionFailedException,
    );
  });

  it('refuses to reassign a reviewer to the employee themselves', async () => {
    const { service, repo } = makeService();
    await expect(service.reassignReviewer('rev-1', EMPLOYEE, ACTOR)).rejects.toThrow(
      PreconditionFailedException,
    );
    expect(repo.reassignReviewer).not.toHaveBeenCalled();
  });
});

describe('applyApproval / applyReturn — called by the type def', () => {
  it('shares the review and records who signed it off, in the given transaction', async () => {
    const { service, repo, audit } = makeService();
    const tx = { tx: 'approval' } as never;
    await service.applyApproval('rev-1', 'hr-9', tx);
    expect(repo.markShared).toHaveBeenCalledWith('rev-1', 'hr-9', tx);
    expect(audit.record).toHaveBeenCalledWith(expect.anything(), tx);
  });

  it('refuses when the review is no longer awaiting approval', async () => {
    const { service } = makeService({ markShared: vi.fn().mockResolvedValue(null) });
    await expect(service.applyApproval('rev-1', 'hr-9', {} as never)).rejects.toThrow(
      PreconditionFailedException,
    );
  });

  it('is SILENT when an expiry lands after a decision', async () => {
    // The engine wins that race either way, and there is nothing to correct — throwing here would
    // fail a cron for a state that is already correct.
    const { service, audit } = makeService({ returnToReviewer: vi.fn().mockResolvedValue(null) });
    await expect(
      service.applyReturn('rev-1', 'reviewer-1', 'expired', {} as never),
    ).resolves.toBeUndefined();
    expect(audit.record).not.toHaveBeenCalled();
  });
});
