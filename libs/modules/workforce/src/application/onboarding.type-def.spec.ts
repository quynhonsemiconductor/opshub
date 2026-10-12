/**
 * OnboardingTypeDef: the Entra account reconcile is a TASK queued in the final approval's transaction,
 * naming the employee. The API makes no Graph call and cannot name a directory object.
 */
import { describe, expect, it, vi } from 'vitest';
import { OnboardingTypeDef } from './onboarding.type-def';

const PAYLOAD = { employeeId: 'emp-1', employeeEmail: 'a@example.com', startDate: '2026-11-01' };

function make() {
  const enqueue = vi.fn().mockResolvedValue(true);
  const typeDef = new OnboardingTypeDef(
    { register: vi.fn() } as never,
    {} as never,
    { enqueue } as never,
  );
  return { typeDef, enqueue };
}

describe('OnboardingTypeDef.onApprove', () => {
  it('queues an account reconcile for the employee in the approval transaction', async () => {
    const { typeDef, enqueue } = make();
    const tx = {};

    await typeDef.onApprove(PAYLOAD, 'req-1', 'approver', tx as never);

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      { kind: 'entra.account.reconcile', payload: { employeeId: 'emp-1' } },
      tx,
    );
  });

  it('carries no directory object id and no enabled flag — the worker decides from current state', async () => {
    const { typeDef, enqueue } = make();

    await typeDef.onApprove(PAYLOAD, 'req-1', 'approver', {} as never);

    expect(Object.keys((enqueue.mock.calls[0][0] as { payload: object }).payload)).toEqual([
      'employeeId',
    ]);
  });

  it('has no post-commit Graph work', () => {
    const { typeDef } = make();
    expect((typeDef as { afterApprove?: unknown }).afterApprove).toBeUndefined();
  });
});
