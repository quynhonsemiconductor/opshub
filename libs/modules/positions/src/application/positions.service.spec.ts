/**
 * PositionsService — the two rules the database cannot hold, and the refusals around them.
 *
 * WHY UNIT TESTS WHEN THERE IS AN E2E SUITE. `positions-headcount.e2e.spec.ts` drives the real API
 * and the real partial unique index, which is the only place `uq_employee_current_position` can be
 * proven. What it cannot do cheaply is pin ORDER and ARGUMENTS: that the outgoing assignment is
 * closed BEFORE the incoming one opens, that the headcount count receives the transaction rather
 * than the pool, and that a refusal happens before any write. Each of those is a specific
 * interleaving, invisible from the outside once the transaction has committed.
 *
 * The repository is a stub and the transaction a passthrough, so what is under test is this
 * service's decisions, not Drizzle.
 */
import { describe, expect, it, vi } from 'vitest';
import { ConflictException, PreconditionFailedException, type DrizzleDB } from '@platform';
import { PositionsService } from './positions.service';
import type { EmployeePosition, Position } from '../domain/positions.types';
import { createFakeAudit } from '../../../audit/src/testing/audit.fake';

const ACTOR = { sub: 'actor-1', email: 'actor@opshub.local' };

function position(over: Partial<Position> = {}): Position {
  return {
    id: 'pos-1',
    code: 'ENG-QA-01',
    title: 'QA Engineer',
    department: 'Engineering',
    rankId: null,
    headcount: 2,
    description: null,
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function assignment(over: Partial<EmployeePosition> = {}): EmployeePosition {
  return {
    id: 'asg-1',
    employeeId: 'emp-1',
    positionId: 'pos-0',
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    endReason: null,
    createdAt: new Date(),
    ...over,
  };
}

function makeService(
  repoOver: Record<string, unknown> = {},
  jobRanksRepoOver: Record<string, unknown> = {},
) {
  const repo = {
    create: vi.fn().mockResolvedValue(position()),
    findById: vi.fn().mockResolvedValue(position()),
    findByCode: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue({ rows: [], total: 0 }),
    update: vi
      .fn()
      .mockImplementation((id: string, input: Partial<Position>) =>
        Promise.resolve(position({ id, ...input })),
      ),
    countOpenAssignments: vi.fn().mockResolvedValue(0),
    findCurrentAssignment: vi.fn().mockResolvedValue(null),
    findAssignmentById: vi.fn().mockResolvedValue(assignment()),
    assign: vi
      .fn()
      .mockImplementation((input: Record<string, unknown>) =>
        Promise.resolve(assignment({ id: 'asg-new', ...input })),
      ),
    endAssignment: vi
      .fn()
      .mockImplementation((id: string) =>
        Promise.resolve(assignment({ id, effectiveTo: '2026-06-30' })),
      ),
    listAssignmentsForEmployee: vi.fn().mockResolvedValue([]),
    listAssignmentsForPosition: vi.fn().mockResolvedValue([]),
    ...repoOver,
  };
  // Passthrough transaction, typed by widening once at the declaration: tsc rejects the bare stub
  // against `NodePgDatabase` while eslint calls a `as never` at the call site unnecessary.
  const TX = { tx: true };
  // Held as a standalone spy, not read back off `db`, so assertions do not detach a method from
  // its object — which is what `@typescript-eslint/unbound-method` objects to.
  const transaction = vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(TX));
  const db = { transaction } as unknown as DrizzleDB;
  const audit = createFakeAudit();

  const jobRanksRepo = {
    findById: vi.fn().mockResolvedValue({ id: 'rank-1', ordinal: 1, name: 'Junior', benefits: [] }),
    ...jobRanksRepoOver,
  };

  const service = new PositionsService(repo, jobRanksRepo as never, db, audit as never);
  return { service, repo, jobRanksRepo, db, transaction, audit, TX };
}

describe('createPosition', () => {
  it('refuses a rank that does not exist, before writing anything', async () => {
    const { service, repo } = makeService({}, { findById: vi.fn().mockResolvedValue(null) });

    await expect(
      service.createPosition(
        { code: 'ENG-QA-03', title: 'QA', department: 'Eng', rankId: 'missing' },
        ACTOR,
      ),
    ).rejects.toThrow(/Rank missing not found/);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('does not look a rank up when the position is created without one', async () => {
    const { service, jobRanksRepo } = makeService();

    await service.createPosition({ code: 'ENG-QA-04', title: 'QA', department: 'Eng' }, ACTOR);

    expect(jobRanksRepo.findById).not.toHaveBeenCalled();
  });

  it('refuses a duplicate code before writing anything', async () => {
    const { service, repo } = makeService({ findByCode: vi.fn().mockResolvedValue(position()) });

    await expect(
      service.createPosition({ code: 'ENG-QA-01', title: 'QA', department: 'Eng' }, ACTOR),
    ).rejects.toThrow(ConflictException);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('writes the audit entry inside the transaction', async () => {
    const { service, audit, TX } = makeService();

    await service.createPosition({ code: 'ENG-QA-02', title: 'QA', department: 'Eng' }, ACTOR);

    // Second argument is the tx — a fire-and-forget audit write would survive a rolled-back create.
    expect(audit.record).toHaveBeenCalledWith(expect.anything(), TX);
  });
});

describe('updatePosition', () => {
  it('allows reducing headcount below current occupancy', async () => {
    // Deliberate: a restructure that cuts three approved seats to two while three people hold them
    // is a real event. The constraint belongs on the NEXT assignment, not on recording the plan.
    const { service, repo } = makeService({
      findById: vi.fn().mockResolvedValue(position({ headcount: 3 })),
      countOpenAssignments: vi.fn().mockResolvedValue(3),
    });

    const after = await service.updatePosition('pos-1', { headcount: 2 }, ACTOR);

    expect(after.headcount).toBe(2);
    expect(repo.update).toHaveBeenCalledWith('pos-1', { headcount: 2 }, expect.anything());
  });
});

describe('assign', () => {
  it('refuses a frozen position without touching the transaction', async () => {
    const { service, repo, transaction } = makeService({
      findById: vi.fn().mockResolvedValue(position({ status: 'frozen' })),
    });

    await expect(
      service.assign(
        { employeeId: 'emp-1', positionId: 'pos-1', effectiveFrom: '2026-03-01' },
        ACTOR,
      ),
    ).rejects.toThrow(PreconditionFailedException);
    // A frozen position keeps its occupants but accepts nobody new; the check is cheap and needs no
    // transaction, so opening one would be wasted work on a refusal path.
    expect(transaction).not.toHaveBeenCalled();
    expect(repo.assign).not.toHaveBeenCalled();
  });

  it('refuses when the position is already at its approved headcount', async () => {
    const { service, repo } = makeService({
      findById: vi.fn().mockResolvedValue(position({ headcount: 2 })),
      countOpenAssignments: vi.fn().mockResolvedValue(2),
    });

    await expect(
      service.assign(
        { employeeId: 'emp-1', positionId: 'pos-1', effectiveFrom: '2026-03-01' },
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: 'POSITION_HEADCOUNT_EXCEEDED' });
    expect(repo.assign).not.toHaveBeenCalled();
  });

  it('counts headcount with the transaction, not the pool', async () => {
    const { service, repo, TX } = makeService();

    await service.assign(
      { employeeId: 'emp-1', positionId: 'pos-1', effectiveFrom: '2026-03-01' },
      ACTOR,
    );

    // The whole point of the in-service headcount rule: counted on the pool, two concurrent
    // assignments both see the last free slot and both take it.
    expect(repo.countOpenAssignments).toHaveBeenCalledWith('pos-1', TX);
  });

  it('closes the outgoing assignment BEFORE opening the incoming one', async () => {
    const order: string[] = [];
    const { service } = makeService({
      findCurrentAssignment: vi.fn().mockResolvedValue(assignment({ positionId: 'pos-0' })),
      endAssignment: vi.fn().mockImplementation((id: string) => {
        order.push('end');
        return Promise.resolve(assignment({ id, effectiveTo: '2026-03-01' }));
      }),
      assign: vi.fn().mockImplementation(() => {
        order.push('assign');
        return Promise.resolve(assignment({ id: 'asg-new' }));
      }),
    });

    await service.assign(
      { employeeId: 'emp-1', positionId: 'pos-1', effectiveFrom: '2026-03-01' },
      ACTOR,
    );

    // Forced by `uq_employee_current_position`: the other order hits the index. Asserted here
    // because the index makes it a 500 rather than a wrong result, and a future refactor that
    // reorders these two would only fail against a real Postgres.
    expect(order).toEqual(['end', 'assign']);
  });

  it('releases the outgoing slot first, so a transfer within a full position is not self-blocked', async () => {
    // The stub answers from actual state rather than a call sequence: the position looks full until
    // the outgoing row is closed. Count before the close and headcount 1 refuses the transfer;
    // count after and it succeeds. So this fails if the two are ever reordered.
    let closed = false;
    const { service, repo } = makeService({
      findById: vi.fn().mockResolvedValue(position({ headcount: 1 })),
      findCurrentAssignment: vi.fn().mockResolvedValue(assignment({ positionId: 'pos-0' })),
      countOpenAssignments: vi.fn().mockImplementation(() => Promise.resolve(closed ? 0 : 1)),
      endAssignment: vi.fn().mockImplementation((id: string) => {
        closed = true;
        return Promise.resolve(assignment({ id, effectiveTo: '2026-03-01' }));
      }),
    });

    await expect(
      service.assign(
        { employeeId: 'emp-1', positionId: 'pos-1', effectiveFrom: '2026-03-01' },
        ACTOR,
      ),
    ).resolves.toMatchObject({ id: 'asg-new' });
    expect(repo.endAssignment).toHaveBeenCalled();
  });

  it('refuses re-assigning someone to the position they already hold', async () => {
    const { service, repo } = makeService({
      findCurrentAssignment: vi.fn().mockResolvedValue(assignment({ positionId: 'pos-1' })),
    });

    await expect(
      service.assign(
        { employeeId: 'emp-1', positionId: 'pos-1', effectiveFrom: '2026-03-01' },
        ACTOR,
      ),
    ).rejects.toThrow(ConflictException);
    // Without this, a transfer to the same position would close and reopen the row, rewriting its
    // start date and losing when the person actually took the job.
    expect(repo.endAssignment).not.toHaveBeenCalled();
    expect(repo.assign).not.toHaveBeenCalled();
  });

  it('refuses a transfer dated before the current assignment began', async () => {
    const { service, repo } = makeService({
      findCurrentAssignment: vi
        .fn()
        .mockResolvedValue(assignment({ positionId: 'pos-0', effectiveFrom: '2026-06-01' })),
    });

    await expect(
      service.assign(
        { employeeId: 'emp-1', positionId: 'pos-1', effectiveFrom: '2026-01-01' },
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: 'POSITION_INVALID_WINDOW' });
    // Found live: without the guard this reached `ck_employee_position_window` and the caller got a
    // 500 with no indication of what was wrong.
    expect(repo.endAssignment).not.toHaveBeenCalled();
  });

  it('allows a transfer dated on the day the current assignment began', async () => {
    // The CHECK is `effective_to >= effective_from`, so a same-day transfer is legal — a zero-length
    // assignment records a correction made on the start date.
    const { service } = makeService({
      findCurrentAssignment: vi
        .fn()
        .mockResolvedValue(assignment({ positionId: 'pos-0', effectiveFrom: '2026-06-01' })),
    });

    await expect(
      service.assign(
        { employeeId: 'emp-1', positionId: 'pos-1', effectiveFrom: '2026-06-01' },
        ACTOR,
      ),
    ).resolves.toBeTruthy();
  });

  it("defaults the outgoing row's end reason to 'transfer'", async () => {
    const { service, repo } = makeService({
      findCurrentAssignment: vi.fn().mockResolvedValue(assignment({ positionId: 'pos-0' })),
    });

    await service.assign(
      { employeeId: 'emp-1', positionId: 'pos-1', effectiveFrom: '2026-03-01' },
      ACTOR,
    );

    expect(repo.endAssignment).toHaveBeenCalledWith(
      'asg-1',
      { effectiveTo: '2026-03-01', endReason: 'transfer' },
      expect.anything(),
    );
  });
});

describe('endAssignment', () => {
  it('refuses an end date before the assignment began', async () => {
    const { service, repo } = makeService({
      findAssignmentById: vi.fn().mockResolvedValue(assignment({ effectiveFrom: '2026-09-01' })),
    });

    await expect(
      service.endAssignment('asg-1', { effectiveTo: '2026-08-01' }, ACTOR),
    ).rejects.toMatchObject({ code: 'POSITION_INVALID_WINDOW' });
    expect(repo.endAssignment).not.toHaveBeenCalled();
  });

  it('reports a missing or already-closed assignment as not found', async () => {
    const { service } = makeService({
      // The repository's WHERE clause is open-only, so null means "already closed or absent" —
      // which is what makes the open-only clause, not the read above it, the authority.
      findAssignmentById: vi.fn().mockResolvedValue(assignment({ effectiveTo: '2026-05-01' })),
      endAssignment: vi.fn().mockResolvedValue(null),
    });

    await expect(
      service.endAssignment('asg-1', { effectiveTo: '2026-06-01' }, ACTOR),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('does not let the validating read veto a close it cannot see', async () => {
    // The read is advisory. If the row is absent from it, the open-only UPDATE still decides —
    // otherwise a row created by a concurrent transaction could never be closed here.
    const { service, repo } = makeService({
      findAssignmentById: vi.fn().mockResolvedValue(null),
    });

    await expect(
      service.endAssignment('asg-1', { effectiveTo: '2026-06-01' }, ACTOR),
    ).resolves.toBeTruthy();
    expect(repo.endAssignment).toHaveBeenCalled();
  });
});

describe('listAssignmentsForPosition', () => {
  it('404s for an unknown position rather than returning an empty history', async () => {
    // An empty array would read as "nobody has ever held it", which is a different fact.
    const { service } = makeService({ findById: vi.fn().mockResolvedValue(null) });

    await expect(service.listAssignmentsForPosition('nope')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
