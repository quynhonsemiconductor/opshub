/**
 * ContractsService — the transition rules, and the refusals that keep constraints out of the 500s.
 *
 * WHY UNIT TESTS WHEN THERE IS AN E2E SUITE. `contracts.e2e.spec.ts` drives the real API and the
 * real `uq_employee_active_contract`, which is the only place that index can be proven. What it
 * cannot do cheaply is pin ORDER and ARGUMENTS: that a renewal takes the outgoing contract out of
 * `active` BEFORE the incoming one goes in, that the guarded `WHERE status = <from>` is what decides
 * a race rather than a prior read, and that a refusal happens before any write. Those are
 * interleavings, invisible from outside once the transaction has committed.
 *
 * The repository is a stub and the transaction a passthrough, so what is under test is this
 * service's decisions, not Drizzle.
 */
import { describe, expect, it, vi } from 'vitest';
import { ConflictException, PreconditionFailedException, type DrizzleDB } from '@platform';
import { addDays, today } from '@shared-kernel';
import { ContractsService } from './contracts.service';
import type { EmploymentContract } from '../domain/contracts.types';
import { createFakeAudit } from '../../../audit/src/testing/audit.fake';

const ACTOR = { sub: 'actor-1', email: 'actor@opshub.local' };

/**
 * `expect.objectContaining` with a declared return type.
 *
 * The raw matcher is typed `any`, and nesting one inside an object literal makes the whole literal
 * unsafe under `@typescript-eslint/no-unsafe-assignment`. Narrowing once here keeps the assertions
 * readable without an inline disable per call.
 */
function containing(shape: Record<string, unknown>): unknown {
  return expect.objectContaining(shape);
}

function contract(over: Partial<EmploymentContract> = {}): EmploymentContract {
  return {
    id: 'con-1',
    employeeId: 'emp-1',
    roleId: null,
    reference: 'EMP-2026-0001',
    contractType: 'fixed_term',
    startDate: '2030-01-01',
    endDate: '2030-12-31',
    probationEndDate: null,
    noticePeriodDays: 30,
    baseSalary: null,
    salaryCurrency: null,
    salaryPeriod: null,
    status: 'draft',
    signedAt: new Date('2029-12-01T00:00:00Z'),
    documentId: null,
    terminatedOn: null,
    terminationReason: null,
    supersededById: null,
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function makeService(repoOver: Record<string, unknown> = {}) {
  const repo = {
    create: vi.fn().mockResolvedValue(contract()),
    findById: vi.fn().mockResolvedValue(contract()),
    findByReference: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue({ rows: [], total: 0 }),
    listForEmployee: vi.fn().mockResolvedValue([]),
    findActiveForEmployee: vi.fn().mockResolvedValue(null),
    update: vi
      .fn()
      .mockImplementation((id: string, input: Partial<EmploymentContract>) =>
        Promise.resolve(contract({ id, ...input })),
      ),
    transition: vi
      .fn()
      .mockImplementation((id: string, _from: string, to: EmploymentContract['status']) =>
        Promise.resolve(contract({ id, status: to })),
      ),
    listExpired: vi.fn().mockResolvedValue([]),
    listExpiringBetween: vi.fn().mockResolvedValue([]),
    ...repoOver,
  };
  const TX = { tx: true };
  // Standalone spy rather than read back off `db`, so assertions do not detach a method from its
  // object — what `@typescript-eslint/unbound-method` objects to.
  const transaction = vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(TX));
  const db = { transaction } as unknown as DrizzleDB;
  const audit = createFakeAudit();
  const notifications = { schedule: vi.fn().mockResolvedValue(undefined) };
  const employees = { getById: vi.fn().mockResolvedValue({ displayName: 'Mai Nguyen' }) };

  const service = new ContractsService(
    repo,
    db,
    audit as never,
    notifications as never,
    employees as never,
  );
  return { service, repo, db, transaction, audit, notifications, employees, TX };
}

describe('date helpers', () => {
  it('formats and shifts dates in UTC', () => {
    // Pinned directly: `addDays` is the reminder window's arithmetic, and a local-time
    // implementation is off by one for half the world without any test noticing.
    expect(today(new Date('2026-03-01T23:30:00Z'))).toBe('2026-03-01');
    expect(addDays('2026-02-27', 3)).toBe('2026-03-02');
    // Across a DST boundary in the northern hemisphere, where a local-time `setDate` drifts.
    expect(addDays('2026-03-28', 1)).toBe('2026-03-29');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('draftContract', () => {
  it('refuses a permanent contract with an end date', async () => {
    const { service, repo } = makeService();

    await expect(
      service.draftContract(
        {
          employeeId: 'emp-1',
          reference: 'EMP-1',
          contractType: 'permanent',
          startDate: '2030-01-01',
          endDate: '2030-12-31',
        },
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: 'CONTRACT_INVALID_TERM' });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('refuses a fixed-term contract without one', async () => {
    const { service, repo } = makeService();

    await expect(
      service.draftContract(
        {
          employeeId: 'emp-1',
          reference: 'EMP-1',
          contractType: 'fixed_term',
          startDate: '2030-01-01',
        },
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: 'CONTRACT_INVALID_TERM' });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('refuses an end date before the start, and probation before the start', async () => {
    const { service } = makeService();
    const base = {
      employeeId: 'emp-1',
      reference: 'EMP-1',
      contractType: 'fixed_term' as const,
      startDate: '2030-06-01',
    };

    await expect(
      service.draftContract({ ...base, endDate: '2030-01-01' }, ACTOR),
    ).rejects.toMatchObject({ code: 'CONTRACT_INVALID_WINDOW' });
    await expect(
      service.draftContract(
        { ...base, endDate: '2030-12-31', probationEndDate: '2030-01-01' },
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: 'CONTRACT_INVALID_WINDOW' });
  });

  it('refuses a duplicate reference before writing anything', async () => {
    const { service, repo } = makeService({
      findByReference: vi.fn().mockResolvedValue(contract()),
    });

    await expect(
      service.draftContract(
        {
          employeeId: 'emp-1',
          reference: 'EMP-2026-0001',
          contractType: 'permanent',
          startDate: '2030-01-01',
        },
        ACTOR,
      ),
    ).rejects.toThrow(ConflictException);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('writes the audit entry inside the transaction', async () => {
    const { service, audit, TX } = makeService();

    await service.draftContract(
      {
        employeeId: 'emp-1',
        reference: 'EMP-2',
        contractType: 'permanent',
        startDate: '2030-01-01',
      },
      ACTOR,
    );

    expect(audit.record).toHaveBeenCalledWith(expect.anything(), TX);
  });
});

describe('updateContract', () => {
  it('refuses to edit anything that is not a draft', async () => {
    const { service, repo } = makeService({
      findById: vi.fn().mockResolvedValue(contract({ status: 'active' })),
    });

    await expect(service.updateContract('con-1', { notes: 'x' }, ACTOR)).rejects.toMatchObject({
      code: 'CONTRACT_NOT_DRAFT',
    });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('validates the MERGED terms, not just the patch', async () => {
    // The case a patch-only check misses: the row is fixed-term with an end date, and the update
    // changes only the type. Validating `{ contractType }` alone passes, and the database then
    // answers `ck_contract_type_end_date` with a 500.
    const { service, repo } = makeService({
      findById: vi
        .fn()
        .mockResolvedValue(contract({ contractType: 'fixed_term', endDate: '2030-12-31' })),
    });

    await expect(
      service.updateContract('con-1', { contractType: 'permanent' }, ACTOR),
    ).rejects.toMatchObject({ code: 'CONTRACT_INVALID_TERM' });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('allows the same change when the end date is cleared in the same patch', async () => {
    const { service, repo } = makeService({
      findById: vi
        .fn()
        .mockResolvedValue(contract({ contractType: 'fixed_term', endDate: '2030-12-31' })),
    });

    await expect(
      service.updateContract('con-1', { contractType: 'permanent', endDate: null }, ACTOR),
    ).resolves.toBeTruthy();
    expect(repo.update).toHaveBeenCalled();
  });

  it('reports a status that moved under it as a conflict, not a 404', async () => {
    // The repository's WHERE clause is draft-only, so a null means the row stopped being a draft
    // between the read and the write. That is a race, and a 404 would misdescribe it.
    const { service } = makeService({ update: vi.fn().mockResolvedValue(null) });

    await expect(service.updateContract('con-1', { notes: 'x' }, ACTOR)).rejects.toMatchObject({
      code: 'CONTRACT_NOT_DRAFT',
    });
  });
});

describe('activateContract', () => {
  it('refuses an unsigned contract', async () => {
    const { service, repo } = makeService({
      findById: vi.fn().mockResolvedValue(contract({ signedAt: null })),
    });

    await expect(service.activateContract('con-1', {}, ACTOR)).rejects.toMatchObject({
      code: 'CONTRACT_NOT_SIGNED',
    });
    expect(repo.transition).not.toHaveBeenCalled();
  });

  it('accepts a signature supplied with the activation', async () => {
    const { service, repo } = makeService({
      findById: vi.fn().mockResolvedValue(contract({ signedAt: null })),
    });

    await service.activateContract('con-1', { signedAt: '2029-12-24T00:00:00.000Z' }, ACTOR);

    expect(repo.transition).toHaveBeenCalledWith(
      'con-1',
      'draft',
      'active',
      { signedAt: new Date('2029-12-24T00:00:00.000Z') },
      expect.anything(),
    );
  });

  it('refuses a contract that has already ended', async () => {
    const { service } = makeService({
      findById: vi
        .fn()
        .mockResolvedValue(contract({ startDate: '2020-01-01', endDate: '2020-12-31' })),
    });

    await expect(service.activateContract('con-1', {}, ACTOR)).rejects.toMatchObject({
      code: 'CONTRACT_ALREADY_ENDED',
    });
  });

  it('refuses when the employee already holds an active contract', async () => {
    const { service, repo } = makeService({
      findActiveForEmployee: vi
        .fn()
        .mockResolvedValue(contract({ id: 'con-old', status: 'active', reference: 'EMP-OLD' })),
    });

    await expect(service.activateContract('con-1', {}, ACTOR)).rejects.toMatchObject({
      code: 'CONTRACT_ALREADY_ACTIVE',
    });
    // Deliberate: quietly superseding would erase the distinction between activating a first
    // contract and renewing an existing one, which have different audit trails.
    expect(repo.transition).not.toHaveBeenCalled();
  });

  it('checks the active slot with the transaction, not the pool', async () => {
    const { service, repo, TX } = makeService();

    await service.activateContract('con-1', {}, ACTOR);

    expect(repo.findActiveForEmployee).toHaveBeenCalledWith('emp-1', TX);
  });
});

describe('renewContract', () => {
  const outgoing = contract({ id: 'con-old', status: 'active', reference: 'EMP-OLD' });
  const incoming = contract({
    id: 'con-new',
    status: 'draft',
    startDate: '2031-01-01',
    endDate: '2031-12-31',
  });

  function renewService(over: Record<string, unknown> = {}) {
    return makeService({
      findById: vi
        .fn()
        .mockImplementation((id: string) =>
          Promise.resolve(id === 'con-old' ? outgoing : incoming),
        ),
      ...over,
    });
  }

  it('takes the outgoing contract out of active BEFORE the incoming one goes in', async () => {
    const order: string[] = [];
    const { service } = renewService({
      transition: vi
        .fn()
        .mockImplementation((id: string, from: string, to: EmploymentContract['status']) => {
          order.push(`${id}:${from}->${to}`);
          return Promise.resolve(contract({ id, status: to }));
        }),
    });

    await service.renewContract('con-old', 'con-new', {}, ACTOR);

    // Forced by `uq_employee_active_contract`: the other order hits the index. Asserted here
    // because against a real Postgres that shows up as a 500, and only under concurrency.
    expect(order[0]).toBe('con-old:active->expired');
    expect(order[1]).toBe('con-new:draft->active');
    // The forward link is written LAST, so it can only ever point at a contract that did activate.
    expect(order[2]).toBe('con-old:expired->expired');
  });

  it('refuses a renewal across two different employees', async () => {
    const { service, repo } = renewService({
      findById: vi
        .fn()
        .mockImplementation((id: string) =>
          Promise.resolve(
            id === 'con-old' ? outgoing : contract({ id: 'con-new', employeeId: 'emp-2' }),
          ),
        ),
    });

    await expect(service.renewContract('con-old', 'con-new', {}, ACTOR)).rejects.toThrow(
      PreconditionFailedException,
    );
    expect(repo.transition).not.toHaveBeenCalled();
  });

  it('refuses to renew a contract that is not active', async () => {
    const { service } = renewService({
      findById: vi.fn().mockResolvedValue(contract({ status: 'expired' })),
    });

    await expect(service.renewContract('con-old', 'con-new', {}, ACTOR)).rejects.toMatchObject({
      code: 'CONTRACT_NOT_ACTIVE',
    });
  });

  it('refuses a successor that starts before the contract it replaces', async () => {
    const { service } = renewService({
      findById: vi
        .fn()
        .mockImplementation((id: string) =>
          Promise.resolve(
            id === 'con-old'
              ? contract({ id: 'con-old', status: 'active', startDate: '2030-06-01' })
              : contract({ id: 'con-new', startDate: '2029-01-01', endDate: '2029-12-31' }),
          ),
        ),
    });

    await expect(service.renewContract('con-old', 'con-new', {}, ACTOR)).rejects.toMatchObject({
      code: 'CONTRACT_INVALID_WINDOW',
    });
  });

  it('refuses a contract renewing itself', async () => {
    const { service, repo } = renewService();

    await expect(service.renewContract('con-old', 'con-old', {}, ACTOR)).rejects.toThrow(
      PreconditionFailedException,
    );
    expect(repo.findById).not.toHaveBeenCalled();
  });

  it('passes the signature through to the incoming contract', async () => {
    // Without this the route was unusable: the incoming draft is unsigned, so every renewal
    // answered CONTRACT_NOT_SIGNED. Found by probing the live API.
    const { service, repo } = renewService({
      findById: vi.fn().mockImplementation((id: string) =>
        Promise.resolve(
          id === 'con-old'
            ? outgoing
            : contract({
                id: 'con-new',
                signedAt: null,
                startDate: '2031-01-01',
                endDate: '2031-12-31',
              }),
        ),
      ),
    });

    await service.renewContract(
      'con-old',
      'con-new',
      { signedAt: '2030-12-24T00:00:00.000Z' },
      ACTOR,
    );

    expect(repo.transition).toHaveBeenCalledWith(
      'con-new',
      'draft',
      'active',
      { signedAt: new Date('2030-12-24T00:00:00.000Z') },
      expect.anything(),
    );
  });

  it('reports a lost race on the outgoing contract as a conflict', async () => {
    const { service } = renewService({
      transition: vi.fn().mockResolvedValue(null),
    });

    await expect(service.renewContract('con-old', 'con-new', {}, ACTOR)).rejects.toMatchObject({
      code: 'CONTRACT_NOT_ACTIVE',
    });
  });
});

describe('terminateContract', () => {
  it('refuses a termination dated before the contract started', async () => {
    const { service, repo } = makeService({
      findById: vi.fn().mockResolvedValue(contract({ status: 'active', startDate: '2030-06-01' })),
    });

    await expect(
      service.terminateContract(
        'con-1',
        { terminatedOn: '2030-01-01', terminationReason: 'resigned' },
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: 'CONTRACT_INVALID_WINDOW' });
    expect(repo.transition).not.toHaveBeenCalled();
  });

  it('refuses to terminate anything that is not active', async () => {
    const { service } = makeService({
      findById: vi.fn().mockResolvedValue(contract({ status: 'draft' })),
    });

    await expect(
      service.terminateContract(
        'con-1',
        { terminatedOn: '2030-06-01', terminationReason: 'resigned' },
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: 'CONTRACT_NOT_ACTIVE' });
  });
});

describe('expireDueContracts', () => {
  const due = [
    { id: 'con-1', employeeId: 'emp-1', reference: 'EMP-1', endDate: '2026-01-01' },
    { id: 'con-2', employeeId: 'emp-2', reference: 'EMP-2', endDate: '2026-01-02' },
  ];

  it('gives each contract its own transaction', async () => {
    const { service, transaction } = makeService({ listExpired: vi.fn().mockResolvedValue(due) });

    await service.expireDueContracts('2026-06-01');

    // One row failing a constraint must not prevent the other hundred from being swept, and there
    // is no invariant spanning two contracts here.
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it('counts contracts actually moved, not rows the query returned', async () => {
    const { service } = makeService({
      listExpired: vi.fn().mockResolvedValue(due),
      // The second lost the guarded UPDATE — terminated by someone between the list and the write.
      transition: vi
        .fn()
        .mockImplementation((id: string) =>
          Promise.resolve(id === 'con-1' ? contract({ id, status: 'expired' }) : null),
        ),
    });

    expect(await service.expireDueContracts('2026-06-01')).toBe(1);
  });

  it('writes an actor-less audit entry — time did this, not a person', async () => {
    const { service, audit } = makeService({
      listExpired: vi.fn().mockResolvedValue([due[0]]),
    });

    await service.expireDueContracts('2026-06-01');

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: null, action: 'contract.expired' }),
      expect.anything(),
    );
  });

  it('keys the notification per contract so a re-run cannot notify twice', async () => {
    const { service, notifications } = makeService({
      listExpired: vi.fn().mockResolvedValue([due[0]]),
    });

    await service.expireDueContracts('2026-06-01');

    expect(notifications.schedule).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: 'contract.expired',
        recipientId: 'emp-1',
        idempotencyKey: 'contract.expired:con-1',
      }),
    );
  });

  it('does not notify about a contract it failed to move', async () => {
    const { service, notifications } = makeService({
      listExpired: vi.fn().mockResolvedValue([due[0]]),
      transition: vi.fn().mockResolvedValue(null),
    });

    await service.expireDueContracts('2026-06-01');

    expect(notifications.schedule).not.toHaveBeenCalled();
  });

  it('names the employee, falling back to their id when the lookup fails', async () => {
    const { service, notifications } = makeService({
      listExpired: vi.fn().mockResolvedValue([due[0]]),
    });
    await service.expireDueContracts('2026-06-01');
    expect(notifications.schedule).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ vars: containing({ employeeName: 'Mai Nguyen' }) }),
    );

    // The sweep runs unattended: a missing employee row must not crash it.
    const broken = makeService({ listExpired: vi.fn().mockResolvedValue([due[0]]) });
    broken.employees.getById.mockRejectedValue(new Error('gone'));
    await broken.service.expireDueContracts('2026-06-01');
    expect(broken.notifications.schedule).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ vars: containing({ employeeName: 'emp-1' }) }),
    );
  });
});

describe('remindExpiringContracts', () => {
  it('asks for the window from today forward, not around today', async () => {
    const { service, repo } = makeService();

    await service.remindExpiringContracts(30, '2026-06-01');

    expect(repo.listExpiringBetween).toHaveBeenCalledWith('2026-06-01', '2026-07-01', 500);
  });

  it('keys each reminder by contract AND window, so an hourly run sends one', async () => {
    const { service, notifications } = makeService({
      listExpiringBetween: vi
        .fn()
        .mockResolvedValue([
          { id: 'con-1', employeeId: 'emp-1', reference: 'EMP-1', endDate: '2026-06-11' },
        ]),
    });

    await service.remindExpiringContracts(30, '2026-06-01');

    expect(notifications.schedule).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: 'contract.expiring_soon',
        idempotencyKey: 'contract.expiring_soon:con-1:30',
        vars: containing({ daysRemaining: 10 }),
      }),
    );
  });
});
