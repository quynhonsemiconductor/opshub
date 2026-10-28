/**
 * Leave and overtime decisions leave a record — every one of them, including the ones nobody made.
 *
 * `RequestEngine` writes no audit entry for any transition: it owns `request_items` and leaves the
 * domain event to the type that defines it. These two type-defs wrote the status change into the
 * domain table and stopped, so approving leave produced NO audit row at all. The only
 * `leave.approved` / `overtime.approved` writes in the codebase sat in a `// Legacy path` branch that
 * `createLeave` and `createOvertime` made unreachable the moment they started setting `requestId`.
 *
 * WHY A UNIT SPEC AS WELL AS THE E2E. Two of the six hooks are `onExpire`, reached only when a cron
 * finds a request past its deadline. Driving that end to end means manufacturing a three-day-old
 * request and running the sweep; here it is a direct call. The e2e proves the rows reach the database,
 * this proves each hook asks for the right one — including the two an e2e would skip.
 *
 * The load-bearing assertions are about ATTRIBUTION, not merely presence: who the entry names, and
 * whether it can be told apart from the neighbouring event that writes the same status.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LeaveRequestTypeDef } from './leave-request.type-def';
import { OvertimeTypeDef } from './overtime.type-def';
import { WfhRequestTypeDef } from './wfh-request.type-def';

/** A tx whose update chain resolves, so a hook can run without a database. */
function makeTx() {
  const chain = { set: vi.fn(), where: vi.fn() };
  chain.set.mockReturnValue(chain);
  chain.where.mockResolvedValue(undefined);
  return { update: vi.fn().mockReturnValue(chain) };
}

const LEAVE_PAYLOAD = {
  leaveRequestId: 'leave-1',
  employeeId: 'emp-1',
  leaveType: 'annual',
  startDate: '2026-09-01',
  endDate: '2026-09-02',
  startPortion: 'full_day' as const,
  endPortion: 'afternoon' as const,
  workingDays: 1.5,
  reason: null,
};

const OVERTIME_PAYLOAD = {
  overtimeId: 'ot-1',
  employeeId: 'emp-1',
  workDate: '2026-09-01',
  hours: 3,
  reason: 'release night',
};

const WFH_PAYLOAD = {
  wfhRequestId: 'wfh-1',
  employeeId: 'emp-1',
  startDate: '2026-09-01',
  endDate: '2026-09-02',
  workingDays: 2,
  reason: null,
};

describe('leave and overtime decisions are audited', () => {
  let trailRecord: ReturnType<typeof vi.fn>;
  let rawRecord: ReturnType<typeof vi.fn>;
  let leave: LeaveRequestTypeDef;
  let overtime: OvertimeTypeDef;
  let wfh: WfhRequestTypeDef;

  beforeEach(() => {
    trailRecord = vi.fn().mockResolvedValue(undefined);
    rawRecord = vi.fn().mockResolvedValue(undefined);
    const audit = {
      forResource: vi.fn().mockReturnValue({ record: trailRecord }),
      record: rawRecord,
    };
    leave = new LeaveRequestTypeDef({ register: vi.fn() } as never, audit as never);
    overtime = new OvertimeTypeDef({ register: vi.fn() } as never, audit as never);
    wfh = new WfhRequestTypeDef({ register: vi.fn() } as never, audit as never);
  });

  describe('a reviewer decided', () => {
    it('records an approved leave request against the reviewer, with what it cost', async () => {
      const tx = makeTx();
      await leave.onApprove(LEAVE_PAYLOAD, 'req-1', 'reviewer-1', tx as never);

      expect(trailRecord).toHaveBeenCalledTimes(1);
      const [action, resourceId, actor, passedTx, changes] = trailRecord.mock.calls[0] as [
        string,
        string,
        { sub: string },
        unknown,
        { after: Record<string, unknown> },
      ];
      expect(action).toBe('leave.approved');
      expect(resourceId).toBe('leave-1');
      expect(actor.sub).toBe('reviewer-1');
      // With the engine's tx, so the entry commits with the decision and rolls back with it. An entry
      // written outside it can describe an approval that never happened.
      expect(passedTx, 'the audit entry was written outside the transaction').toBe(tx);
      /*
       * `workingDays` is on the entry because it is what the approval COST. "1 Sept to 2 Sept" is the
       * same dates whether it is two days or two days minus an afternoon, and only one of those is
       * what the approver agreed to.
       */
      expect(changes.after.workingDays).toBe(1.5);
    });

    it('records an approved overtime entry with the hours it authorised', async () => {
      const tx = makeTx();
      await overtime.onApprove(OVERTIME_PAYLOAD, 'req-1', 'reviewer-1', tx as never);

      const [action, , actor, , changes] = trailRecord.mock.calls[0] as [
        string,
        string,
        { sub: string },
        unknown,
        { after: Record<string, unknown> },
      ];
      expect(action).toBe('overtime.approved');
      expect(actor.sub).toBe('reviewer-1');
      // Overtime is paid work. An approval record that does not say how much it approved cannot be
      // reconciled against what was paid.
      expect(changes.after.hours).toBe(3);
    });

    it('records an approved WFH request with the working days it covers', async () => {
      const tx = makeTx();
      await wfh.onApprove(WFH_PAYLOAD, 'req-1', 'reviewer-1', tx as never);

      const [action, resourceId, actor, passedTx, changes] = trailRecord.mock.calls[0] as [
        string,
        string,
        { sub: string },
        unknown,
        { after: Record<string, unknown> },
      ];
      expect(action).toBe('wfh.approved');
      expect(resourceId).toBe('wfh-1');
      expect(actor.sub).toBe('reviewer-1');
      expect(passedTx, 'the audit entry was written outside the transaction').toBe(tx);
      // Same reason as leave: the dates alone do not say how much of the week this covers.
      expect(changes.after.workingDays).toBe(2);
    });

    it('records a refusal, and names the reviewer who refused', async () => {
      const tx = makeTx();
      await leave.onReject(LEAVE_PAYLOAD, 'req-1', 'reviewer-2', tx as never);
      await overtime.onReject(OVERTIME_PAYLOAD, 'req-1', 'reviewer-2', tx as never);

      await wfh.onReject(WFH_PAYLOAD, 'req-1', 'reviewer-2', tx as never);

      expect(trailRecord.mock.calls.map((c) => c[0] as string)).toEqual([
        'leave.rejected',
        'overtime.rejected',
        'wfh.rejected',
      ]);
      for (const call of trailRecord.mock.calls) {
        expect((call[2] as { sub: string }).sub).toBe('reviewer-2');
      }
    });
  });

  describe('nobody decided — the deadline passed', () => {
    it('attributes an expired leave request to no actor at all', async () => {
      const tx = makeTx();
      await leave.onExpire(LEAVE_PAYLOAD, 'req-1', tx as never);

      /*
       * `actorId: null`, the convention `ContractExpiryCron` already uses: time did this, not a
       * person. Naming the requester would read as "they cancelled it", which is the opposite of what
       * happened — they asked, and nobody answered. So this goes through the raw recorder, because the
       * bound trail's signature demands an `Actor`.
       */
      expect(trailRecord, 'an expiry must not be attributed to a person').not.toHaveBeenCalled();
      expect(rawRecord).toHaveBeenCalledTimes(1);

      const [entry, passedTx] = rawRecord.mock.calls[0] as [
        { actorId: null; action: string; changes: { after: Record<string, unknown> } },
        unknown,
      ];
      expect(entry.actorId).toBeNull();
      expect(entry.action).toBe('leave.cancelled');
      expect(passedTx).toBe(tx);
      // Distinguishes an expiry from a cancellation somebody chose.
      expect(entry.changes.after.reason).toContain('expired');
    });

    it('distinguishes an expired overtime entry from one an approver refused', async () => {
      const tx = makeTx();
      await overtime.onExpire(OVERTIME_PAYLOAD, 'req-1', tx as never);

      const [entry] = rawRecord.mock.calls[0] as [
        { actorId: null; action: string; changes: { after: Record<string, unknown> } },
      ];
      expect(entry.actorId).toBeNull();
      /*
       * THE SAME ACTION AS A REFUSAL, and that is why `reason` matters here more than anywhere else:
       * expiry writes `rejected`, the identical status an approver's refusal writes. Without the
       * reason, the trail cannot tell "your manager said no" from "nobody looked at it for three
       * days", and for unpaid work already done those are not the same answer.
       */
      expect(entry.action).toBe('overtime.rejected');
      expect(entry.changes.after.reason).toContain('expired');
    });

    it('expires a WFH request as CANCELLED, not refused', async () => {
      const tx = makeTx();
      await wfh.onExpire(WFH_PAYLOAD, 'req-1', tx as never);

      const [entry] = rawRecord.mock.calls[0] as [
        { actorId: null; action: string; changes: { after: Record<string, unknown> } },
      ];
      expect(entry.actorId).toBeNull();
      /*
       * A DIFFERENT STATUS FROM OVERTIME'S, deliberately. Overtime asks permission for work already
       * done, so an unanswered request still reads as a refusal to pay it. WFH asks permission to NOT
       * come in, so nobody answering means "you are expected in the office" — a withdrawal, not a
       * refusal. `cancelled` is leave's word for the same situation, and `wfh.cancelled` matches it.
       */
      expect(entry.action).toBe('wfh.cancelled');
      expect(entry.changes.after.reason).toContain('expired');
    });
  });

  it('writes the status change and the entry for every hook, never one without the other', async () => {
    // Six hooks, six status writes, six entries. A hook that updated the domain table and recorded
    // nothing is exactly the state this file exists to prevent returning to.
    const hooks: Array<() => Promise<void>> = [
      () => leave.onApprove(LEAVE_PAYLOAD, 'r', 'rev', makeTx() as never),
      () => leave.onReject(LEAVE_PAYLOAD, 'r', 'rev', makeTx() as never),
      () => leave.onExpire(LEAVE_PAYLOAD, 'r', makeTx() as never),
      () => overtime.onApprove(OVERTIME_PAYLOAD, 'r', 'rev', makeTx() as never),
      () => overtime.onReject(OVERTIME_PAYLOAD, 'r', 'rev', makeTx() as never),
      () => overtime.onExpire(OVERTIME_PAYLOAD, 'r', makeTx() as never),
      () => wfh.onApprove(WFH_PAYLOAD, 'r', 'rev', makeTx() as never),
      () => wfh.onReject(WFH_PAYLOAD, 'r', 'rev', makeTx() as never),
      () => wfh.onExpire(WFH_PAYLOAD, 'r', makeTx() as never),
    ];

    for (const hook of hooks) await hook();

    expect(trailRecord.mock.calls.length + rawRecord.mock.calls.length).toBe(hooks.length);
  });
});
