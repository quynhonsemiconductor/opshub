/**
 * Unit tests — the WFH request flow's rules: overlap both ways, the window shape, the manager
 * assignee, and the cancel/review paths' engine pairing.
 *
 * The repository and db are fakes; the assertions are about WHICH questions the service asks
 * before it writes, and which engine door a transition goes through — the parts an e2e run would
 * only prove by failing in production.
 */
import { createFakeAudit } from '../../../audit/src/testing/audit.fake';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException, PreconditionFailedException, ActorScope } from '@platform';
import { WorkforceService } from './workforce.service';

const mockRepo = {
  overlappingLeaveCandidates: vi.fn().mockResolvedValue([]),
  overlappingWfhWindows: vi.fn().mockResolvedValue([]),
  createLeave: vi.fn().mockResolvedValue({
    id: 'leave-1',
    employeeId: 'emp-1',
    leaveType: 'annual',
    startDate: '2026-11-02',
    endDate: '2026-11-03',
    startPortion: 'full_day',
    endPortion: 'full_day',
    reason: null,
    workingDays: '2',
    documentStorageKey: null,
    status: 'pending',
    reviewerId: null,
    reviewedAt: null,
    createdAt: new Date(),
    requestId: null,
  }),
  createWfh: vi
    .fn()
    .mockImplementation(
      (input: { employeeId: string; startDate: string; workingDays: number }) => ({
        id: 'wfh-1',
        employeeId: input.employeeId,
        startDate: input.startDate,
        endDate: '2026-11-04',
        workingDays: input.workingDays,
        reason: null,
        status: 'pending',
        reviewerId: null,
        reviewedAt: null,
        createdAt: new Date(),
        requestId: null,
      }),
    ),
  setLeaveRequestId: vi.fn(),
  setWfhRequestId: vi.fn(),
  findLeaveById: vi.fn(),
  findWfhById: vi.fn(),
};
const mockAudit = createFakeAudit();
const mockEngine = { submit: vi.fn(), approve: vi.fn(), reject: vi.fn(), cancel: vi.fn() };
const mockStorage = { presignUpload: vi.fn(), confirmUpload: vi.fn() };
const mockAuthz = { check: vi.fn().mockResolvedValue(false) };
// A tx that runs its callback and answers the advisory-lock execute.
const mockDb = {
  transaction: vi.fn((cb: (tx: unknown) => unknown) =>
    cb({ execute: vi.fn().mockResolvedValue({ rows: [] }) }),
  ),
  select: vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
    }),
  }),
};

const mockBalances = {
  holidaysBetween: vi.fn().mockResolvedValue(new Set()),
  leaveCostFor: vi.fn().mockResolvedValue(2),
  assertSufficientBalance: vi.fn().mockResolvedValue(undefined),
};

const SELF = { sub: 'emp-1', email: 'emp1@test.com' };

function service(): WorkforceService {
  return new WorkforceService(
    mockRepo as never,
    mockAudit as never,
    mockEngine as never,
    mockStorage as never,
    mockAuthz as never,
    new ActorScope(mockAuthz as never),
    mockBalances as never,
    mockDb as never,
  );
}

/** A future window, so the past rule never fires. */
const FUTURE = () => {
  const d = new Date(Date.now() + 7 * 3_600_000 + 30 * 86_400_000);
  const iso = d.toISOString().slice(0, 10);
  return { startDate: iso, endDate: iso };
};

describe('createWfh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthz.check.mockResolvedValue(false);
  });

  it('refuses a window overlapping live LEAVE, and live WFH — the rule runs both ways', async () => {
    mockRepo.overlappingLeaveCandidates.mockResolvedValueOnce([
      { startDate: FUTURE().startDate, endDate: FUTURE().startDate },
    ]);
    await expect(service().createWfh(FUTURE(), SELF)).rejects.toBeInstanceOf(ConflictException);
    expect(mockRepo.createWfh).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mockRepo.overlappingWfhWindows.mockResolvedValueOnce([
      { startDate: FUTURE().startDate, endDate: FUTURE().startDate },
    ]);
    await expect(service().createWfh(FUTURE(), SELF)).rejects.toBeInstanceOf(ConflictException);
  });

  it('submits with the manager as assignee, so the engine can pin the decision on them', async () => {
    mockDb.select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi
          .fn()
          .mockReturnValue({ limit: vi.fn().mockResolvedValue([{ managerId: 'mgr-1' }]) }),
      }),
    });
    mockEngine.submit.mockResolvedValue({ id: 'req-1' });
    mockAuthz.check.mockResolvedValueOnce(true); // the manager holds workforce.wfh.review
    await service().createWfh(FUTURE(), SELF);
    expect(mockAuthz.check).toHaveBeenCalledWith('mgr-1', 'workforce.wfh.review');
    expect(mockEngine.submit).toHaveBeenCalledWith(
      'wfh_request',
      expect.objectContaining({ employeeId: SELF.sub }),
      SELF,
      expect.objectContaining({ assigneeId: 'mgr-1' }),
    );
  });

  it('a self-named manager resolves to unassigned rather than a stalled request', async () => {
    mockDb.select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi
          .fn()
          .mockReturnValue({ limit: vi.fn().mockResolvedValue([{ managerId: SELF.sub }]) }),
      }),
    });
    mockEngine.submit.mockResolvedValue({ id: 'req-1' });
    await service().createWfh(FUTURE(), SELF);
    const opts = (mockEngine.submit as ReturnType<typeof vi.fn>).mock.calls[0][3] as {
      assigneeId?: string;
    };
    expect(opts.assigneeId).toBeUndefined();
  });

  it('falls back to unassigned (HR/admin) when the manager is offboarded', async () => {
    mockDb.select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi
            .fn()
            .mockResolvedValueOnce([{ managerId: 'mgr-1' }])
            .mockResolvedValueOnce([{ status: 'offboarded' }]),
        }),
      }),
    });
    mockEngine.submit.mockResolvedValue({ id: 'req-1' });
    mockAuthz.check.mockResolvedValue(true);
    await service().createWfh(FUTURE(), SELF);
    const opts = mockEngine.submit.mock.calls[0][3] as { assigneeId?: string };
    expect(opts.assigneeId).toBeUndefined();
  });

  it('falls back to unassigned (HR/admin) when the manager lacks the review permission', async () => {
    mockDb.select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi
            .fn()
            .mockResolvedValueOnce([{ managerId: 'mgr-1' }])
            .mockResolvedValueOnce([{ status: 'active' }]),
        }),
      }),
    });
    mockEngine.submit.mockResolvedValue({ id: 'req-1' });
    mockAuthz.check.mockResolvedValue(false);
    await service().createWfh(FUTURE(), SELF);
    const opts = mockEngine.submit.mock.calls[0][3] as { assigneeId?: string };
    expect(opts.assigneeId).toBeUndefined();
  });

  it('refuses a window starting in the past', async () => {
    await expect(
      service().createWfh({ startDate: '2026-01-05', endDate: '2026-01-06' }, SELF),
    ).rejects.toBeInstanceOf(PreconditionFailedException);
  });

  it('refuses a window longer than 92 days', async () => {
    const far = FUTURE();
    await expect(
      service().createWfh({ startDate: far.startDate, endDate: '2027-06-01' }, SELF),
    ).rejects.toBeInstanceOf(PreconditionFailedException);
  });
});

describe('createLeave refuses WFH days too', () => {
  beforeEach(() => vi.clearAllMocks());

  it('a live WFH window over the leave window is a 409 LEAVE_OVERLAPPING', async () => {
    const w = FUTURE();
    mockRepo.overlappingWfhWindows.mockResolvedValueOnce([
      { startDate: w.startDate, endDate: w.endDate },
    ]);
    await expect(
      service().createLeave(
        { leaveType: 'annual', startDate: w.startDate, endDate: w.endDate },
        SELF,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(mockRepo.createLeave).not.toHaveBeenCalled();
  });
});

describe('withdrawals go through the engine', () => {
  beforeEach(() => vi.clearAllMocks());

  it('cancelWfh with an engine item calls engine.cancel — one transaction, both rows', async () => {
    mockRepo.findWfhById.mockResolvedValue({
      id: 'wfh-1',
      employeeId: SELF.sub,
      startDate: '2026-11-02',
      endDate: '2026-11-03',
      workingDays: 2,
      reason: null,
      status: 'pending',
      reviewerId: null,
      reviewedAt: null,
      createdAt: new Date(),
      requestId: 'req-9',
    });
    mockRepo.findWfhById.mockResolvedValueOnce({
      id: 'wfh-1',
      employeeId: SELF.sub,
      startDate: '2026-11-02',
      endDate: '2026-11-03',
      workingDays: 2,
      reason: null,
      status: 'cancelled',
      reviewerId: null,
      reviewedAt: null,
      createdAt: new Date(),
      requestId: 'req-9',
    });
    await service().cancelWfh('wfh-1', SELF);
    expect(mockEngine.cancel).toHaveBeenCalledWith('req-9', SELF);
  });

  it('reviewWfh refuses an orphan row whose engine item never landed', async () => {
    mockRepo.findWfhById.mockResolvedValue({
      id: 'wfh-1',
      employeeId: SELF.sub,
      startDate: '2026-11-02',
      endDate: '2026-11-03',
      workingDays: 2,
      reason: null,
      status: 'pending',
      reviewerId: null,
      reviewedAt: null,
      createdAt: new Date(),
      requestId: null,
    });
    await expect(service().reviewWfh('wfh-1', true, SELF)).rejects.toBeInstanceOf(
      PreconditionFailedException,
    );
    expect(mockEngine.approve).not.toHaveBeenCalled();
  });
});

describe('createLeave checks the balance BEFORE inserting', () => {
  beforeEach(() => vi.clearAllMocks());

  it('an insufficient balance refuses before any row is written or lock taken', async () => {
    const w = FUTURE();
    mockBalances.leaveCostFor.mockResolvedValue(2);
    mockBalances.assertSufficientBalance.mockRejectedValueOnce(
      new PreconditionFailedException('LEAVE_INSUFFICIENT_BALANCE', 'not enough'),
    );
    await expect(
      service().createLeave(
        { leaveType: 'annual', startDate: w.startDate, endDate: w.endDate },
        SELF,
      ),
    ).rejects.toBeInstanceOf(PreconditionFailedException);
    expect(mockRepo.createLeave).not.toHaveBeenCalled();
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it('on success the balance is asked for first, then the row is inserted', async () => {
    const w = FUTURE();
    mockBalances.leaveCostFor.mockResolvedValue(2);
    mockEngine.submit.mockResolvedValue({ id: 'req-1' });
    const order: string[] = [];
    mockBalances.assertSufficientBalance.mockImplementationOnce(() => {
      order.push('balance');
      return Promise.resolve();
    });
    mockRepo.createLeave.mockImplementationOnce(() => {
      order.push('insert');
      return Promise.resolve({ id: 'leave-1', startDate: w.startDate, endDate: w.endDate });
    });
    await service()
      .createLeave({ leaveType: 'annual', startDate: w.startDate, endDate: w.endDate }, SELF)
      .catch(() => undefined);
    expect(order).toEqual(['balance', 'insert']);
  });
});

describe('previewWfh', () => {
  it('lists the working days of the window, skipping weekends and public holidays', async () => {
    // Fri 2026-11-06 .. Tue 2026-11-10: Fri, [Sat, Sun], Mon, Tue; Monday is a declared holiday.
    mockBalances.holidaysBetween.mockResolvedValueOnce(new Set(['2026-11-09']));
    const out = await service().previewWfh('2026-11-06', '2026-11-10');
    expect(out).toEqual({
      startDate: '2026-11-06',
      endDate: '2026-11-10',
      workingDays: ['2026-11-06', '2026-11-10'],
    });
  });

  it('a weekend-only window previews as no working day', async () => {
    mockBalances.holidaysBetween.mockResolvedValueOnce(new Set());
    const out = await service().previewWfh('2026-11-07', '2026-11-08');
    expect(out.workingDays).toEqual([]);
  });
});
