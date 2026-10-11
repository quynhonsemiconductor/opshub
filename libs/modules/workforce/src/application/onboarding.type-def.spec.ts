/**
 * OnboardingTypeDef: the Entra account enable is a TASK queued in the final approval's transaction.
 * The API no longer calls Graph, so there is nothing to call after the commit.
 */
import { describe, expect, it, vi } from 'vitest';
import { OnboardingTypeDef } from './onboarding.type-def';

const PAYLOAD = { employeeId: 'emp-1', employeeEmail: 'a@example.com', startDate: '2026-11-01' };

function make(entraOid: string | null) {
  const enqueue = vi.fn().mockResolvedValue(true);
  const select = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([{ entraOid }]),
  };
  const tx = { select: vi.fn().mockReturnValue(select) };
  const typeDef = new OnboardingTypeDef(
    { register: vi.fn() } as never,
    {} as never,
    { enqueue } as never,
  );
  return { typeDef, enqueue, tx };
}

describe('OnboardingTypeDef.onApprove', () => {
  it('queues the account enable in the approval transaction', async () => {
    const { typeDef, enqueue, tx } = make('entra-oid-1');

    await typeDef.onApprove(PAYLOAD, 'req-1', 'approver', tx as never);

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      { kind: 'entra.account.set_enabled', payload: { entraOid: 'entra-oid-1', enabled: true } },
      tx,
    );
  });

  it('queues nothing for an employee with no Entra object id', async () => {
    const { typeDef, enqueue, tx } = make(null);

    await typeDef.onApprove(PAYLOAD, 'req-1', 'approver', tx as never);

    expect(enqueue).not.toHaveBeenCalled();
  });

  it('has no post-commit Graph work', () => {
    const { typeDef } = make('x');
    expect((typeDef as { afterApprove?: unknown }).afterApprove).toBeUndefined();
  });
});
